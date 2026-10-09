import { describe, expect, it } from "vitest";

import {
  decodeDirectoryCursor,
  decodeTimelineCursor,
  encodeDirectoryCursor,
  encodeTimelineCursor,
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

describe("directory cursor", () => {
  const search = {
    sort: "last_visit",
    filter: "visited",
    query: "léa",
  } as const;

  it("round-trips, microseconds and the 'none' sentinels kept exactly", () => {
    for (const key of [
      "2026-10-01T09:00:00.654321+00:00",
      "-infinity",
      "infinity",
    ]) {
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

  it("checks the key's type against the ordering", () => {
    const named = encodeDirectoryCursor({
      asOf: AS_OF,
      sort: "most_visits",
      filter: "all",
      query: "",
      key: "not a number",
      id: ID,
    });
    expectRefused(() =>
      decodeDirectoryCursor(named, {
        sort: "most_visits",
        filter: "all",
        query: "",
      }),
    );
    const counted = encodeDirectoryCursor({
      asOf: AS_OF,
      sort: "newest",
      filter: "all",
      query: "",
      key: 3,
      id: ID,
    });
    expectRefused(() =>
      decodeDirectoryCursor(counted, {
        sort: "newest",
        filter: "all",
        query: "",
      }),
    );
  });

  it("refuses garbage, other kinds and forged identifiers", () => {
    const search = { sort: "name", filter: "all", query: "" } as const;
    expectRefused(() => decodeDirectoryCursor("not-base64-json", search));
    expectRefused(() =>
      decodeDirectoryCursor(
        encodeTimelineCursor({
          asOf: AS_OF,
          clientId: ID,
          at: AS_OF,
          id: `email:${ID}`,
        }),
        search,
      ),
    );
    expectRefused(() =>
      decodeDirectoryCursor(
        Buffer.from(
          JSON.stringify({
            v: 1,
            t: "clients",
            asOf: AS_OF,
            ...search,
            key: "a",
            id: "x",
          }),
        ).toString("base64url"),
        search,
      ),
    );
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

  it("refuses an event id of an unknown kind", () => {
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        t: "timeline",
        asOf: AS_OF,
        clientId: ID,
        at: AS_OF,
        id: `review:${OTHER}`,
      }),
    ).toString("base64url");
    expectRefused(() => decodeTimelineCursor(cursor, ID));
  });
});
