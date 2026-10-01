import { describe, expect, it } from "vitest";

import {
  addDaysToLocalDate,
  localDateRangeToUtc,
  startOfLocalDate,
  zonedBoundToUtc,
  zonedDateOf,
  zonedLocalToUtc,
} from "./zoned";

const HOUR = 3_600_000;
const iso = (value: Date) => value.toISOString();
const hours = ({ startsAt, endsAt }: { startsAt: Date; endsAt: Date }) =>
  (endsAt.getTime() - startsAt.getTime()) / HOUR;

describe("startOfLocalDate: where a local day really begins", () => {
  it("repeated midnight (Havana, 2026-11-01): the first occurrence", () => {
    // 00:59 CDT → 00:00 CST at 05:00Z: midnight at 04:00Z and at 05:00Z.
    expect(iso(startOfLocalDate("2026-11-01", "America/Havana"))).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    // The generic rule picks the second one: the first hour would be lost.
    expect(iso(zonedLocalToUtc("2026-11-01T00:00", "America/Havana"))).toBe(
      "2026-11-01T05:00:00.000Z",
    );
    expect(
      hours(localDateRangeToUtc("2026-11-01", "2026-11-01", "America/Havana")),
    ).toBe(25);
  });

  it("skipped midnight: the first instant after the gap", () => {
    // Havana 2027-03-14 and Santiago 2026-09-06: 23:59 → 01:00.
    expect(iso(startOfLocalDate("2027-03-14", "America/Havana"))).toBe(
      "2027-03-14T05:00:00.000Z",
    );
    const santiago = localDateRangeToUtc(
      "2026-09-06",
      "2026-09-06",
      "America/Santiago",
    );
    expect(iso(santiago.startsAt)).toBe("2026-09-06T04:00:00.000Z");
    expect(hours(santiago)).toBe(23);
  });

  it("repeated late evening (Santiago, Beirut): the previous day lasts 25 h", () => {
    expect(
      hours(
        localDateRangeToUtc("2027-04-03", "2027-04-03", "America/Santiago"),
      ),
    ).toBe(25);
    expect(
      hours(localDateRangeToUtc("2026-10-24", "2026-10-24", "Asia/Beirut")),
    ).toBe(25);
  });

  it("23 h, 24 h and 25 h days in Paris", () => {
    expect(
      hours(localDateRangeToUtc("2027-03-28", "2027-03-28", "Europe/Paris")),
    ).toBe(23);
    expect(
      hours(localDateRangeToUtc("2026-11-10", "2026-11-10", "Europe/Paris")),
    ).toBe(24);
    expect(
      hours(localDateRangeToUtc("2026-10-25", "2026-10-25", "Europe/Paris")),
    ).toBe(25);
  });

  it("30-minute (Lord Howe) and 2-hour (Troll) transitions", () => {
    expect(
      hours(
        localDateRangeToUtc("2026-10-04", "2026-10-04", "Australia/Lord_Howe"),
      ),
    ).toBe(23.5);
    expect(
      hours(
        localDateRangeToUtc("2027-04-04", "2027-04-04", "Australia/Lord_Howe"),
      ),
    ).toBe(24.5);
    expect(
      hours(
        localDateRangeToUtc("2027-03-28", "2027-03-28", "Antarctica/Troll"),
      ),
    ).toBe(22);
    expect(
      hours(
        localDateRangeToUtc("2026-10-25", "2026-10-25", "Antarctica/Troll"),
      ),
    ).toBe(26);
  });

  it("a date that does not exist (Apia, 2011-12-30) is an empty day", () => {
    const skipped = localDateRangeToUtc(
      "2011-12-30",
      "2011-12-30",
      "Pacific/Apia",
    );
    expect(skipped.startsAt).toEqual(skipped.endsAt);
    // Its neighbours are whole days, adjacent across the jump.
    expect(
      localDateRangeToUtc("2011-12-29", "2011-12-29", "Pacific/Apia").endsAt,
    ).toEqual(startOfLocalDate("2011-12-31", "Pacific/Apia"));
  });

  it("midnight bounds of a period mean the start of that day", () => {
    expect(iso(zonedBoundToUtc("2026-11-01T00:00", "America/Havana"))).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    // Other times keep the engine's rule.
    expect(iso(zonedBoundToUtc("2026-11-01T00:30", "America/Havana"))).toBe(
      iso(zonedLocalToUtc("2026-11-01T00:30", "America/Havana")),
    );
  });
});

// Adversarial sweep: every day of several years in zones whose transitions
// happen at or around midnight, by 30 minutes or 2 hours, or skip a date.
describe("startOfLocalDate invariants across atypical IANA zones", () => {
  const cases: [string, number, number][] = [
    ["America/Havana", 2024, 2027],
    ["America/Santiago", 2024, 2027],
    ["America/Asuncion", 2022, 2024],
    ["America/Sao_Paulo", 2017, 2019],
    ["Asia/Beirut", 2025, 2027],
    ["Africa/Cairo", 2024, 2027],
    ["Asia/Damascus", 2020, 2022],
    ["Australia/Lord_Howe", 2025, 2027],
    ["Antarctica/Troll", 2025, 2027],
    ["Pacific/Apia", 2011, 2012],
    ["Pacific/Chatham", 2026, 2026],
    ["Europe/Paris", 2026, 2027],
    ["Asia/Kolkata", 2026, 2026],
  ];

  it.each(cases)("%s %i–%i", (zone, fromYear, toYear) => {
    let date = `${fromYear}-01-01`;
    const last = `${toYear}-12-31`;

    while (date <= last) {
      const start = startOfLocalDate(date, zone);
      const next = startOfLocalDate(addDaysToLocalDate(date, 1), zone);

      // First instant whose local date is ≥ date…
      expect(zonedDateOf(start, zone) >= date).toBe(true);
      expect(zonedDateOf(new Date(start.getTime() - 60_000), zone) < date).toBe(
        true,
      );
      // …days tile time without gap or overlap, never backwards…
      expect(next.getTime()).toBeGreaterThanOrEqual(start.getTime());

      date = addDaysToLocalDate(date, 1);
    }
  });
});
