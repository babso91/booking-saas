import { z } from "zod";

import {
  CLIENT_FILTERS,
  CLIENT_SORTS,
  type ClientFilter,
  type ClientSort,
} from "@/features/crm/types";
import { AppException } from "@/lib/errors";

// Opaque pagination cursors: base64url of a small versioned JSON document.
// A cursor only positions a read (the last item read and the reference
// instant of the first page); it is never authority. Every page re-checks
// the session's business and the customer in PostgreSQL.
//
// Decoding is strict and bounded: anything this module did not produce is
// refused with validation_error on `cursor`, before any database call, so
// no client input can reach PostgreSQL as a malformed value (an internal
// error) or shape the query beyond its typed parameters:
//   * base64url alphabet only, canonical (re-encoding gives the same text:
//     no trailing garbage, no stray bits), at most 1024 characters and 768
//     decoded bytes, valid UTF-8;
//   * a strict JSON object of the expected version and kind, no extra key;
//   * instants exactly as PostgreSQL writes them (YYYY-MM-DDTHH:MM:SS, up to
//     6 fractional digits, Z or ±HH:MM[:SS]), checked field by field against
//     the Gregorian calendar (no February 30) and kept as the original text
//     (microseconds preserved: never re-serialized through Date);
//   * identifiers with the 8-4-4-4-12 hexadecimal UUID syntax (any version);
//   * counts as safe integers within PostgreSQL's integer, and ≥ 0.
// A well-formed cursor made for another search, filter, ordering or
// customer is refused too.

export const MAX_CURSOR_LENGTH = 1024;
const MAX_DECODED_BYTES = 768;
const MAX_INTEGER = 2_147_483_647;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2})(?::(\d{2}))?)$/;
const EVENT_ID =
  /^(?:appointment|loyalty|email):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function daysInMonth(year: number, month: number) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** An instant as PostgreSQL writes it, on a real calendar date. */
export function isPostgresTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const [offsetHours, offsetMinutes, offsetSeconds] = match
    .slice(7, 10)
    .map((part) => (part === undefined ? 0 : Number(part))) as [
    number,
    number,
    number,
  ];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHours <= 15 &&
    offsetMinutes <= 59 &&
    offsetSeconds <= 59
  );
}

const timestamp = z.string().max(40).refine(isPostgresTimestamp);
const uuid = z.string().regex(UUID);
/** Text PostgreSQL can hold: well-formed Unicode, no NUL. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.isWellFormed() && !value.includes("\u0000"));

const directoryCursorSchema = z.strictObject({
  v: z.literal(1),
  t: z.literal("clients"),
  asOf: timestamp,
  sort: z.enum(CLIENT_SORTS),
  filter: z.enum(CLIENT_FILTERS),
  query: text(100),
  key: z.union([
    text(512),
    z.number().int().min(0).max(MAX_INTEGER).refine(Number.isSafeInteger),
  ]),
  id: uuid,
});

const timelineCursorSchema = z.strictObject({
  v: z.literal(1),
  t: z.literal("timeline"),
  asOf: timestamp,
  clientId: uuid,
  at: timestamp,
  id: z.string().regex(EVENT_ID),
});

export type DirectoryCursor = {
  asOf: string;
  sort: ClientSort;
  filter: ClientFilter;
  query: string;
  /** Text (name), instant (newest, last_visit, next_appointment) or count. */
  key: string | number;
  id: string;
};

export type TimelineCursor = {
  asOf: string;
  clientId: string;
  at: string;
  id: string;
};

function invalidCursor(cause?: unknown) {
  return new AppException("validation_error", {
    fieldErrors: {
      cursor: ["Pagination invalide : recommencez depuis le début."],
    },
    cause,
  });
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(cursor: string, schema: z.ZodType<T>): T {
  if (
    cursor.length > MAX_CURSOR_LENGTH ||
    !BASE64URL.test(cursor) ||
    cursor.length % 4 === 1
  ) {
    throw invalidCursor();
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (
    bytes.length > MAX_DECODED_BYTES ||
    bytes.toString("base64url") !== cursor
  ) {
    throw invalidCursor();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw invalidCursor(error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidCursor(parsed.error);
  return parsed.data;
}

export function encodeDirectoryCursor(cursor: DirectoryCursor): string {
  return encode({ v: 1, t: "clients", ...cursor });
}

/** The cursor's key must have the type of its ordering's key. */
function keyMatches(sort: ClientSort, key: string | number): boolean {
  switch (sort) {
    case "name":
      return typeof key === "string";
    case "most_visits":
      return typeof key === "number";
    case "newest":
      return typeof key === "string" && isPostgresTimestamp(key);
    case "last_visit":
      // Never visited: -infinity (crm_list_clients).
      return (
        typeof key === "string" &&
        (key === "-infinity" || isPostgresTimestamp(key))
      );
    case "next_appointment":
      // No upcoming appointment: infinity.
      return (
        typeof key === "string" &&
        (key === "infinity" || isPostgresTimestamp(key))
      );
  }
}

/** The cursor, if it belongs to this very search, filter and ordering. */
export function decodeDirectoryCursor(
  cursor: string,
  expected: { sort: ClientSort; filter: ClientFilter; query: string },
): DirectoryCursor {
  const value = decode(cursor, directoryCursorSchema);
  if (
    value.sort !== expected.sort ||
    value.filter !== expected.filter ||
    value.query !== expected.query ||
    !keyMatches(expected.sort, value.key)
  ) {
    throw invalidCursor();
  }
  return {
    asOf: value.asOf,
    sort: expected.sort,
    filter: expected.filter,
    query: expected.query,
    key: value.key,
    id: value.id,
  };
}

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return encode({ v: 1, t: "timeline", ...cursor });
}

/** The cursor, if it belongs to this customer's timeline. */
export function decodeTimelineCursor(
  cursor: string,
  clientId: string,
): TimelineCursor {
  const value = decode(cursor, timelineCursorSchema);
  if (value.clientId.toLowerCase() !== clientId.toLowerCase()) {
    throw invalidCursor();
  }
  return {
    asOf: value.asOf,
    clientId: value.clientId,
    at: value.at,
    id: value.id,
  };
}
