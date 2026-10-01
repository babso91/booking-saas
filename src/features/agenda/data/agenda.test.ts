import { describe, expect, it } from "vitest";

import { datesOf, localStartToUtc } from "./agenda";

// Day bounds and opening ranges come from PostgreSQL (public.business_time);
// they are tested against the database in tests/integration. Here: what the
// server still decides by itself, from the database's resolution.

const at = (value: string) => new Date(value);

describe("localStartToUtc (on PostgreSQL's resolution)", () => {
  it("refuses a start that does not exist", () => {
    expect(() =>
      localStartToUtc({
        status: "nonexistent",
        bound: at("2027-03-28T01:30:00Z"),
      }),
    ).toThrow(expect.objectContaining({ code: "validation_error" }));
  });

  it("never picks an occurrence of a repeated time by itself", () => {
    const repeated = {
      status: "ambiguous" as const,
      first: at("2026-10-25T00:30:00Z"),
      second: at("2026-10-25T01:30:00Z"),
      bound: at("2026-10-25T01:30:00Z"),
    };

    expect(() => localStartToUtc(repeated)).toThrow(
      expect.objectContaining({ code: "ambiguous_local_time" }),
    );
    expect(localStartToUtc(repeated, "first").toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(localStartToUtc(repeated, "second").toISOString()).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });

  it("keeps the database's instant, whatever the occurrence sent", () => {
    const exact = {
      status: "exact" as const,
      instant: at("2026-10-25T09:00:00Z"),
      bound: at("2026-10-25T09:00:00Z"),
    };

    expect(localStartToUtc(exact, "first").toISOString()).toBe(
      "2026-10-25T09:00:00.000Z",
    );
  });
});

describe("datesOf", () => {
  it("lists every civil date of the range, across DST changes", () => {
    expect(datesOf("2026-10-24", "2026-10-26")).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
    expect(datesOf("2026-12-31", "2027-01-01")).toEqual([
      "2026-12-31",
      "2027-01-01",
    ]);
  });
});
