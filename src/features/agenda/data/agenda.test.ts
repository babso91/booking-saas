import { describe, expect, it } from "vitest";

import { localDaysToUtc, localStartToUtc, openRangesByDay } from "./agenda";

const hours = (weekday: number, startsAt: string, endsAt: string) => ({
  id: `${weekday}-${startsAt}`,
  weekday,
  startsAt,
  endsAt,
});

describe("openRangesByDay", () => {
  it("converts weekly hours on each date, following DST", () => {
    // Saturday 24 and Sunday 25 October 2026, Paris: CEST then CET.
    const days = openRangesByDay(
      "2026-10-24",
      "2026-10-25",
      "Europe/Paris",
      [hours(6, "09:00", "12:00"), hours(0, "10:00", "24:00")],
      [],
    );

    expect(days).toEqual([
      {
        date: "2026-10-24",
        weekday: 6,
        openRanges: [
          {
            startsAt: "2026-10-24T07:00:00.000Z",
            endsAt: "2026-10-24T10:00:00.000Z",
            localStartsAt: "2026-10-24T09:00",
            localEndsAt: "2026-10-24T12:00",
          },
        ],
      },
      {
        date: "2026-10-25",
        weekday: 0,
        openRanges: [
          {
            startsAt: "2026-10-25T09:00:00.000Z",
            endsAt: "2026-10-25T23:00:00.000Z",
            localStartsAt: "2026-10-25T10:00",
            localEndsAt: "2026-10-26T00:00",
          },
        ],
      },
    ]);
  });

  it("drops a range emptied by the spring gap, like the database", () => {
    // Sunday 28 March 2027, Paris: 02:00 → 03:00.
    const [day] = openRangesByDay(
      "2027-03-28",
      "2027-03-28",
      "Europe/Paris",
      [hours(0, "02:30", "03:00"), hours(0, "09:00", "10:00")],
      [],
    );

    expect(day!.openRanges.map((range) => range.localStartsAt)).toEqual([
      "2027-03-28T09:00",
    ]);
  });

  it("adds exceptional openings clipped to the day, in order", () => {
    const [day] = openRangesByDay(
      "2026-10-20",
      "2026-10-20",
      "UTC",
      [hours(2, "14:00", "18:00")],
      [
        {
          starts_at: "2026-10-19T20:00:00Z",
          ends_at: "2026-10-20T10:00:00Z",
        },
      ],
    );

    expect(
      day!.openRanges.map((range) => [range.localStartsAt, range.localEndsAt]),
    ).toEqual([
      ["2026-10-20T00:00", "2026-10-20T10:00"],
      ["2026-10-20T14:00", "2026-10-20T18:00"],
    ]);
  });
});

describe("local bounds", () => {
  it("covers whole local days, 25-hour day included", () => {
    const { startsAt, endsAt } = localDaysToUtc(
      "2026-10-25",
      "2026-10-25",
      "Europe/Paris",
    );

    expect(endsAt.getTime() - startsAt.getTime()).toBe(25 * 3_600_000);
  });

  it("refuses a start that does not exist", () => {
    expect(() =>
      localStartToUtc("2027-03-28", "02:30", "Europe/Paris"),
    ).toThrow(expect.objectContaining({ code: "validation_error" }));
  });

  it("never picks an occurrence of a repeated time by itself", () => {
    expect(() =>
      localStartToUtc("2026-10-25", "02:30", "Europe/Paris"),
    ).toThrow(expect.objectContaining({ code: "ambiguous_local_time" }));
    expect(
      localStartToUtc(
        "2026-10-25",
        "02:30",
        "Europe/Paris",
        "first",
      ).toISOString(),
    ).toBe("2026-10-25T00:30:00.000Z");
    expect(
      localStartToUtc(
        "2026-10-25",
        "02:30",
        "Europe/Paris",
        "second",
      ).toISOString(),
    ).toBe("2026-10-25T01:30:00.000Z");
    // Outside the repeated hour the occurrence is irrelevant.
    expect(
      localStartToUtc(
        "2026-10-25",
        "10:00",
        "Europe/Paris",
        "first",
      ).toISOString(),
    ).toBe("2026-10-25T09:00:00.000Z");
  });
});

describe("openRangesByDay on irregular days (same rules as public slots)", () => {
  const allDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
    hours(weekday, "00:00", "24:00"),
  );

  it("Havana, repeated midnight: 31 Oct ends and 1 Nov starts at the FIRST midnight", () => {
    const days = openRangesByDay(
      "2026-10-31",
      "2026-11-01",
      "America/Havana",
      allDay,
      [],
    );

    expect(
      days.map((day) => day.openRanges.map((r) => [r.startsAt, r.endsAt])),
    ).toEqual([
      [["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"]],
      [["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]],
    ]);
  });

  it("Havana, skipped midnight: the day opens after the gap", () => {
    const [day] = openRangesByDay(
      "2027-03-14",
      "2027-03-14",
      "America/Havana",
      allDay,
      [],
    );

    expect(day!.openRanges.map((r) => [r.startsAt, r.endsAt])).toEqual([
      ["2027-03-14T05:00:00.000Z", "2027-03-15T04:00:00.000Z"],
    ]);
  });

  it("Apia, a date that does not exist: no opening at all", () => {
    const [day] = openRangesByDay(
      "2011-12-30",
      "2011-12-30",
      "Pacific/Apia",
      allDay,
      [],
    );

    expect(day!.openRanges).toEqual([]);
  });
});
