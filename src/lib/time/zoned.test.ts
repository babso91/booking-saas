import { describe, expect, it } from "vitest";

import {
  isValidTimeZone,
  utcToZonedLocal,
  zonedDateOf,
  zonedLocalToUtc,
} from "./zoned";

describe("zonedLocalToUtc", () => {
  it.each([
    ["2026-01-15T10:00", "Europe/Paris", "2026-01-15T09:00:00.000Z"],
    ["2026-07-15T10:00", "Europe/Paris", "2026-07-15T08:00:00.000Z"],
    ["2026-07-15T10:00", "America/New_York", "2026-07-15T14:00:00.000Z"],
    ["2026-07-15T10:00", "Asia/Kolkata", "2026-07-15T04:30:00.000Z"],
    ["2026-07-15T00:00", "UTC", "2026-07-15T00:00:00.000Z"],
  ])("converts %s in %s", (local, timeZone, expected) => {
    expect(zonedLocalToUtc(local, timeZone).toISOString()).toBe(expected);
  });

  // Expected values are those of PostgreSQL `timestamp AT TIME ZONE`.
  it("reads a time inside the spring gap with the pre-transition offset", () => {
    expect(
      zonedLocalToUtc("2026-03-29T02:30", "Europe/Paris").toISOString(),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("resolves an ambiguous autumn time to the later instant", () => {
    expect(
      zonedLocalToUtc("2026-10-25T02:30", "Europe/Paris").toISOString(),
    ).toBe("2026-10-25T01:30:00.000Z");
    expect(
      zonedLocalToUtc("2026-11-01T01:30", "America/New_York").toISOString(),
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  it("rejects malformed input", () => {
    expect(() => zonedLocalToUtc("2026-01-15 10:00", "Europe/Paris")).toThrow(
      RangeError,
    );
  });
});

describe("utcToZonedLocal / zonedDateOf", () => {
  it("formats an instant as wall-clock time of the zone", () => {
    expect(utcToZonedLocal("2026-07-15T22:30:00Z", "Europe/Paris")).toBe(
      "2026-07-16T00:30",
    );
    expect(zonedDateOf("2026-07-15T22:30:00Z", "Europe/Paris")).toBe(
      "2026-07-16",
    );
    expect(zonedDateOf("2026-07-15T22:30:00Z", "America/New_York")).toBe(
      "2026-07-15",
    );
  });

  it("round-trips with zonedLocalToUtc", () => {
    const local = "2026-12-24T18:45";

    expect(
      utcToZonedLocal(
        zonedLocalToUtc(local, "Pacific/Auckland"),
        "Pacific/Auckland",
      ),
    ).toBe(local);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and rejects unknown ones", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
