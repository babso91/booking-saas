import { describe, expect, it } from "vitest";

import {
  decodeDirectoryCursor,
  decodeTimelineCursor,
  encodeDirectoryCursor,
  encodeTimelineCursor,
  isPostgresTimestamp,
  MAX_CURSOR_LENGTH,
} from "./cursor";

const ID = "6f1f8a2e-6a4d-4c8b-9a3e-2b7d1c0e5f4a";
const OTHER = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const AS_OF = "2026-10-09T08:00:00.123456+00:00";

const expectRefused = (run: () => unknown) =>
  expect(run).toThrow(
    expect.objectContaining({
      code: "validation_error",
      fieldErrors: { cursor: expect.any(Array) },
    }),
  );

/** A cursor as JSON, encoded the way the module encodes. */
const raw = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const NAME = { sort: "name", filter: "all", query: "" } as const;
const directory = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  t: "clients",
  asOf: AS_OF,
  ...NAME,
  key: "léa martin",
  id: ID,
  ...overrides,
});
const timeline = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  t: "timeline",
  asOf: AS_OF,
  clientId: ID,
  at: AS_OF,
  id: `email:${OTHER}`,
  ...overrides,
});

describe("directory cursor", () => {
  const search = {
    sort: "last_visit",
    filter: "visited",
    query: "léa",
  } as const;

  it("round-trips, microseconds and the 'none' sentinel kept exactly", () => {
    for (const key of ["2026-10-01T09:00:00.654321+00:00", "-infinity"]) {
      const cursor = encodeDirectoryCursor({
        asOf: AS_OF,
        ...search,
        key,
        id: ID,
      });
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeDirectoryCursor(cursor, search)).toEqual({
        asOf: AS_OF,
        ...search,
        key,
        id: ID,
      });
    }
    const next = {
      sort: "next_appointment",
      filter: "all",
      query: "",
    } as const;
    expect(
      decodeDirectoryCursor(
        encodeDirectoryCursor({
          asOf: AS_OF,
          ...next,
          key: "infinity",
          id: ID,
        }),
        next,
      ).key,
    ).toBe("infinity");
  });

  it("is refused for another search, filter or ordering", () => {
    const cursor = encodeDirectoryCursor({
      asOf: AS_OF,
      ...search,
      key: "-infinity",
      id: ID,
    });
    expectRefused(() =>
      decodeDirectoryCursor(cursor, { ...search, query: "emma" }),
    );
    expectRefused(() =>
      decodeDirectoryCursor(cursor, { ...search, filter: "all" }),
    );
    expectRefused(() =>
      decodeDirectoryCursor(cursor, { ...search, sort: "newest" }),
    );
  });

  it("checks the key's type and sentinels against the ordering", () => {
    const bySort = (sort: (typeof NAME)["sort"] | string, key: unknown) =>
      raw(directory({ sort, key }));
    const check = (sort: string, key: unknown) =>
      decodeDirectoryCursor(bySort(sort, key), {
        sort: sort as "name",
        filter: "all",
        query: "",
      });
    expectRefused(() => check("most_visits", "not a number"));
    expectRefused(() => check("newest", 3));
    expectRefused(() => check("name", 3));
    // A sentinel only where it means "none".
    expectRefused(() => check("newest", "-infinity"));
    expectRefused(() => check("last_visit", "infinity"));
    expectRefused(() => check("next_appointment", "-infinity"));
  });

  it("counts are PostgreSQL integers ≥ 0: bounds accepted, overflow and non-integers refused", () => {
    const check = (key: unknown) =>
      decodeDirectoryCursor(raw(directory({ sort: "most_visits", key })), {
        sort: "most_visits",
        filter: "all",
        query: "",
      });
    expect(check(0).key).toBe(0);
    expect(check(2147483647).key).toBe(2147483647);
    expectRefused(() => check(2147483648));
    expectRefused(() => check(-1));
    expectRefused(() => check(1.5));
    expectRefused(() => check(9007199254740993));
    expectRefused(() => check(1e400));
    expectRefused(() => check("12"));
  });

  it("refuses unknown versions, kinds, enum values and extra keys", () => {
    expectRefused(() => decodeDirectoryCursor(raw(directory({ v: 2 })), NAME));
    expectRefused(() =>
      decodeDirectoryCursor(raw(directory({ t: "timeline" })), NAME),
    );
    expectRefused(() =>
      decodeDirectoryCursor(raw(directory({ sort: "vip" })), NAME),
    );
    expectRefused(() =>
      decodeDirectoryCursor(raw(directory({ extra: "x" })), NAME),
    );
    expectRefused(() => decodeDirectoryCursor(raw([directory()]), NAME));
    expectRefused(() => decodeDirectoryCursor(raw(null), NAME));
    expectRefused(() =>
      decodeDirectoryCursor(raw(directory({ id: "not-a-uuid" })), NAME),
    );
    expectRefused(() =>
      decodeDirectoryCursor(raw(directory({ key: "a\u0000b" })), NAME),
    );
  });
});

describe("encoding", () => {
  const valid = encodeDirectoryCursor({
    asOf: AS_OF,
    ...NAME,
    key: "léa martin",
    id: ID,
  });

  it("accepts what the module encodes", () => {
    expect(decodeDirectoryCursor(valid, NAME).key).toBe("léa martin");
  });

  it("refuses malformed base64url, padding, trailing garbage and stray bits", () => {
    for (const cursor of [
      "not base64!",
      `${valid}=`,
      `${valid}==`,
      valid.replace(/.$/, "+"),
      valid.replace(/.$/, "/"),
      `${valid}A`,
      `${valid}AAAA`,
      `${valid}.`,
      `${valid}\n`,
      // Same bytes, non-canonical last character (unused bits set).
      Buffer.from("ab").toString("base64url").replace(/.$/, "J"),
    ]) {
      expectRefused(() => decodeDirectoryCursor(cursor, NAME));
    }
  });

  it("refuses oversized cursors and malformed JSON or UTF-8", () => {
    expectRefused(() =>
      decodeDirectoryCursor("A".repeat(MAX_CURSOR_LENGTH + 4), NAME),
    );
    expectRefused(() =>
      decodeDirectoryCursor(raw(directory({ query: "x".repeat(700) })), NAME),
    );
    expectRefused(() =>
      decodeDirectoryCursor(
        Buffer.from("{not json").toString("base64url"),
        NAME,
      ),
    );
    expectRefused(() =>
      decodeDirectoryCursor(
        Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString("base64url"),
        NAME,
      ),
    );
  });
});

describe("timestamps", () => {
  it("accepts PostgreSQL's own output, microseconds included", () => {
    for (const value of [
      "2026-10-09T08:00:00+00:00",
      "2026-10-09T08:00:00.1+00:00",
      "2026-10-09T08:00:00.123456+00:00",
      "2026-10-09T08:00:00.123456Z",
      "2026-10-09T08:00:00-07:00",
      "1890-03-01T00:00:00+00:09:21",
      "2024-02-29T23:59:59.999999+14:00",
      "2000-02-29T00:00:00+00:00",
    ]) {
      expect(isPostgresTimestamp(value)).toBe(true);
    }
  });

  it("refuses impossible dates, invalid syntax and offsets", () => {
    for (const value of [
      "2026-02-30T00:00:00+00:00",
      "2026-02-29T00:00:00+00:00",
      "1900-02-29T00:00:00+00:00",
      "2026-04-31T00:00:00+00:00",
      "2026-13-01T00:00:00+00:00",
      "2026-00-10T00:00:00+00:00",
      "0000-01-01T00:00:00+00:00",
      "2026-10-09T24:00:00+00:00",
      "2026-10-09T23:60:00+00:00",
      "2026-10-09T23:59:60+00:00",
      "2026-10-09T08:00:00.1234567+00:00",
      "2026-10-09T08:00:00+16:00",
      "2026-10-09T08:00:00+05:60",
      "2026-10-09T08:00:00",
      "2026-10-09 08:00:00+00:00",
      "2026-10-9T08:00:00+00:00",
      "infinity",
      "Thu, 09 Oct 2026 08:00:00 GMT",
      "",
    ]) {
      expect(isPostgresTimestamp(value)).toBe(false);
    }
  });

  it("keeps the original text of a valid instant (never re-serialized)", () => {
    const cursor = encodeTimelineCursor({
      asOf: "2026-10-09T08:00:00.000001+00:00",
      clientId: ID,
      at: "2026-09-30T07:15:00.999999-07:00",
      id: `appointment:${OTHER}`,
    });
    expect(decodeTimelineCursor(cursor, ID)).toMatchObject({
      asOf: "2026-10-09T08:00:00.000001+00:00",
      at: "2026-09-30T07:15:00.999999-07:00",
    });
  });

  it("refuses cursors whose instants are impossible", () => {
    expectRefused(() =>
      decodeTimelineCursor(
        raw(timeline({ at: "2026-02-30T10:00:00+00:00" })),
        ID,
      ),
    );
    expectRefused(() =>
      decodeTimelineCursor(
        raw(timeline({ asOf: "2025-02-29T10:00:00+00:00" })),
        ID,
      ),
    );
    expectRefused(() =>
      decodeDirectoryCursor(
        raw(directory({ sort: "newest", key: "2026-02-30T10:00:00+00:00" })),
        { sort: "newest", filter: "all", query: "" },
      ),
    );
    expect(
      decodeTimelineCursor(
        raw(timeline({ at: "2024-02-29T10:00:00+00:00" })),
        ID,
      ).at,
    ).toBe("2024-02-29T10:00:00+00:00");
  });
});

describe("timeline cursor", () => {
  it("round-trips for its own customer only", () => {
    const cursor = encodeTimelineCursor({
      asOf: AS_OF,
      clientId: ID,
      at: "2026-09-30T07:15:00.000001+00:00",
      id: `appointment:${OTHER}`,
    });
    expect(decodeTimelineCursor(cursor, ID)).toEqual({
      asOf: AS_OF,
      clientId: ID,
      at: "2026-09-30T07:15:00.000001+00:00",
      id: `appointment:${OTHER}`,
    });
    expectRefused(() => decodeTimelineCursor(cursor, OTHER));
  });

  it("requires <kind>:<uuid> event ids of a known kind (any UUID version)", () => {
    for (const id of [
      `review:${OTHER}`,
      "email:------------------------------------",
      `email:${OTHER}x`,
      `email${OTHER}`,
      "email:",
      `appointment:${OTHER.replace(/-/g, "")}`,
    ]) {
      expectRefused(() => decodeTimelineCursor(raw(timeline({ id })), ID));
    }
    // A version 7 (time-ordered) UUID is a UUID all the same.
    const v7 = "01890a5d-ac96-774b-bcce-b302099a8057";
    expect(
      decodeTimelineCursor(raw(timeline({ id: `loyalty:${v7}` })), ID).id,
    ).toBe(`loyalty:${v7}`);
  });

  it("refuses an invalid customer id, another kind or extra keys", () => {
    expectRefused(() =>
      decodeTimelineCursor(raw(timeline({ clientId: "nope" })), ID),
    );
    expectRefused(() =>
      decodeTimelineCursor(raw(timeline({ t: "clients" })), ID),
    );
    expectRefused(() => decodeTimelineCursor(raw(timeline({ v: 0 })), ID));
    expectRefused(() =>
      decodeTimelineCursor(raw(timeline({ businessId: OTHER })), ID),
    );
  });
});
