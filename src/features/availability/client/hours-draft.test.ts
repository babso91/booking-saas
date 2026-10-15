import { describe, expect, it } from "vitest";

import {
  checkWeek,
  hoursFromWeek,
  nextRange,
  rangeLabel,
  scheduleKey,
  serverDayErrors,
  timeOptions,
  TIME_OPTIONS,
  weekFromHours,
} from "./hours-draft";

const read = [
  { weekday: 2, startsAt: "14:00", endsAt: "19:00" },
  { weekday: 2, startsAt: "09:00", endsAt: "12:30" },
  { weekday: 6, startsAt: "10:00", endsAt: "24:00" },
];

describe("weekly hours draft", () => {
  it("shows the week Monday first, each day with its ranges in order, empty days closed", () => {
    const week = weekFromHours(read);
    expect(week.map((day) => day.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(week[0]).toEqual({ weekday: 1, open: false, ranges: [] });
    expect(week[1]!.ranges).toEqual([
      { startsAt: "09:00", endsAt: "12:30" },
      { startsAt: "14:00", endsAt: "19:00" },
    ]);
  });

  it("always sends the complete week; a closed day sends nothing, even with ranges kept in the draft", () => {
    const week = weekFromHours(read).map((day) =>
      day.weekday === 6 ? { ...day, open: false } : day,
    );
    expect(hoursFromWeek(week)).toEqual([
      { weekday: 2, startsAt: "09:00", endsAt: "12:30" },
      { weekday: 2, startsAt: "14:00", endsAt: "19:00" },
    ]);
    // Re-opening restores the kept ranges.
    expect(hoursFromWeek(weekFromHours(read))).toHaveLength(3);
    expect(scheduleKey(hoursFromWeek(weekFromHours(read)))).toBe(
      scheduleKey(read),
    );
  });

  it("refuses what the backend refuses: end before start, overlaps, an open day without range", () => {
    const week = weekFromHours([
      { weekday: 1, startsAt: "10:00", endsAt: "09:00" },
      { weekday: 3, startsAt: "09:00", endsAt: "13:00" },
      { weekday: 3, startsAt: "12:00", endsAt: "18:00" },
      { weekday: 4, startsAt: "09:00", endsAt: "12:00" },
      { weekday: 4, startsAt: "12:00", endsAt: "18:00" },
    ]).map((day) => (day.weekday === 5 ? { ...day, open: true } : day));
    expect(checkWeek(week)).toEqual({
      1: "Chaque plage doit finir après son début.",
      3: "Deux plages de ce jour se chevauchent.",
      5: "Ajoute une plage ou ferme ce jour.",
    });
  });

  it("maps refused ranges back to their day", () => {
    const sent = hoursFromWeek(weekFromHours(read));
    expect(serverDayErrors(sent, { "hours.2": ["x"] })).toEqual({
      6: "Cette plage a été refusée : vérifie ses horaires et ceux du même jour.",
    });
  });

  it("offers 15-minute choices up to midnight and keeps a stored value off that grid", () => {
    expect(TIME_OPTIONS[0]).toBe("00:00");
    expect(TIME_OPTIONS.at(-1)).toBe("24:00");
    expect(TIME_OPTIONS).toHaveLength(97);
    const options = timeOptions("10:05");
    expect(options.indexOf("10:05")).toBe(options.indexOf("10:00") + 1);
  });

  it("proposes a next range after the last one, within the day", () => {
    expect(nextRange([])).toEqual({ startsAt: "09:00", endsAt: "18:00" });
    expect(nextRange([{ startsAt: "09:00", endsAt: "12:00" }])).toEqual({
      startsAt: "13:00",
      endsAt: "14:00",
    });
    // Late in the day: right after the last range, never overlapping it.
    expect(nextRange([{ startsAt: "20:00", endsAt: "23:30" }])).toEqual({
      startsAt: "23:30",
      endsAt: "24:00",
    });
    // The last range may not be the latest one listed.
    expect(
      nextRange([
        { startsAt: "14:00", endsAt: "18:00" },
        { startsAt: "09:00", endsAt: "12:00" },
      ]),
    ).toEqual({ startsAt: "19:00", endsAt: "20:00" });
    // Full up to midnight: nothing more to add.
    expect(nextRange([{ startsAt: "18:00", endsAt: "24:00" }])).toBeNull();
    expect(rangeLabel({ startsAt: "09:30", endsAt: "24:00" })).toBe(
      "9 h 30 – 24 h",
    );
  });
});
