import { describe, expect, it } from "vitest";

import {
  addDaysToLocalDate,
  daysBetweenLocalDates,
  isExistingLocalTime,
  isValidTimeZone,
  resolveZonedLocal,
  utcToZonedLocal,
  zonedDateOf,
  zonedLocalToUtc,
  zonedOccurrenceOf,
  zonedTimeOnDateToUtc,
  weekdayOfLocalDate,
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

describe("local calendar dates", () => {
  it("adds days across months, years and DST changes", () => {
    expect(addDaysToLocalDate("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDaysToLocalDate("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDaysToLocalDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToLocalDate("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("counts calendar days", () => {
    expect(daysBetweenLocalDates("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetweenLocalDates("2026-10-01", "2026-10-01")).toBe(0);
    expect(daysBetweenLocalDates("2026-10-02", "2026-10-01")).toBe(-1);
  });

  it("gives the weekday like PostgreSQL extract(dow)", () => {
    expect(weekdayOfLocalDate("2026-09-27")).toBe(0); // Sunday
    expect(weekdayOfLocalDate("2026-10-03")).toBe(6); // Saturday
  });

  it("maps 24:00 to the next local midnight, DST day included", () => {
    // 2026-10-25 lasts 25 hours in Paris.
    expect(
      zonedTimeOnDateToUtc("2026-10-25", "00:00", "Europe/Paris").toISOString(),
    ).toBe("2026-10-24T22:00:00.000Z");
    expect(
      zonedTimeOnDateToUtc("2026-10-25", "24:00", "Europe/Paris").toISOString(),
    ).toBe("2026-10-25T23:00:00.000Z");
  });

  it("detects local times skipped by the spring transition", () => {
    expect(isExistingLocalTime("2026-03-29T02:30", "Europe/Paris")).toBe(false);
    expect(isExistingLocalTime("2026-03-29T03:00", "Europe/Paris")).toBe(true);
    // Ambiguous autumn time exists (it resolves to the later instant).
    expect(isExistingLocalTime("2026-10-25T02:30", "Europe/Paris")).toBe(true);
  });
});

describe("resolveZonedLocal", () => {
  it("returns the single instant of a normal time", () => {
    expect(resolveZonedLocal("2026-10-25T10:00", "Europe/Paris")).toEqual({
      status: "exact",
      instant: new Date("2026-10-25T09:00:00.000Z"),
    });
  });

  it("returns both instants of the repeated autumn hour, earlier first", () => {
    expect(resolveZonedLocal("2026-10-25T02:30", "Europe/Paris")).toEqual({
      status: "ambiguous",
      first: new Date("2026-10-25T00:30:00.000Z"),
      second: new Date("2026-10-25T01:30:00.000Z"),
    });
  });

  it("reports a time skipped in spring", () => {
    expect(resolveZonedLocal("2027-03-28T02:30", "Europe/Paris")).toEqual({
      status: "nonexistent",
    });
  });

  it("names the occurrence of an instant", () => {
    expect(zonedOccurrenceOf("2026-10-25T00:30:00Z", "Europe/Paris")).toBe(
      "first",
    );
    expect(zonedOccurrenceOf("2026-10-25T01:30:00Z", "Europe/Paris")).toBe(
      "second",
    );
    expect(
      zonedOccurrenceOf("2026-10-25T09:00:00Z", "Europe/Paris"),
    ).toBeNull();
    // Same wall clock, other zone: no transition that night.
    expect(
      zonedOccurrenceOf("2026-10-25T00:30:00Z", "America/New_York"),
    ).toBeNull();
  });
});
