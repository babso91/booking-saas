import { z } from "zod";

import type { ClientFilter, ClientSort } from "@/features/crm/types";
import { AppException } from "@/lib/errors";

// Opaque pagination cursors: base64url of a small versioned JSON document.
// A cursor only positions a read (the last item read and the reference
// instant of the first page); it is never authority. Every page re-checks
// the session's business and the customer in PostgreSQL. A cursor that does
// not decode, or was made for another search, filter, ordering or customer,
// is refused (validation_error on `cursor`).

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
/** Sort key instants may be the "none" sentinels of crm_list_clients. */
const sortInstant = z.union([
  z.literal("infinity"),
  z.literal("-infinity"),
  instant,
]);

const directoryCursorSchema = z.object({
  v: z.literal(1),
  t: z.literal("clients"),
  asOf: instant,
  sort: z.string(),
  filter: z.string(),
  query: z.string(),
  key: z.union([z.string(), z.number().int()]),
  id: z.uuid(),
});

const timelineCursorSchema = z.object({
  v: z.literal(1),
  t: z.literal("timeline"),
  asOf: instant,
  clientId: z.uuid(),
  at: instant,
  id: z.string().regex(/^(appointment|loyalty|email):[0-9a-f-]{36}$/),
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
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
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

/** The cursor, if it belongs to this very search, filter and ordering. */
export function decodeDirectoryCursor(
  cursor: string,
  expected: { sort: ClientSort; filter: ClientFilter; query: string },
): DirectoryCursor {
  const value = decode(cursor, directoryCursorSchema);
  if (
    value.sort !== expected.sort ||
    value.filter !== expected.filter ||
    value.query !== expected.query
  ) {
    throw invalidCursor();
  }
  const keyIsValid =
    expected.sort === "name"
      ? typeof value.key === "string"
      : expected.sort === "most_visits"
        ? typeof value.key === "number" && value.key >= 0
        : typeof value.key === "string" &&
          sortInstant.safeParse(value.key).success;
  if (!keyIsValid) throw invalidCursor();
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
  if (value.clientId !== clientId) throw invalidCursor();
  return {
    asOf: value.asOf,
    clientId: value.clientId,
    at: value.at,
    id: value.id,
  };
}
