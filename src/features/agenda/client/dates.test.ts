import { describe, expect, it } from "vitest";

import {
  formatDuration,
  minutesOf,
  periodLabel,
  shiftAnchor,
  startOfWeek,
  timeFromMinutes,
  visibleRange,
} from "./dates";

describe("agenda dates", () => {
  it("weeks start on Monday", () => {
    expect(startOfWeek("2026-09-29")).toBe("2026-09-28"); // Tuesday
    expect(startOfWeek("2026-10-04")).toBe("2026-09-28"); // Sunday
    expect(startOfWeek("2026-09-28")).toBe("2026-09-28");
  });

  it("reads exactly the visible days", () => {
    expect(visibleRange("week", "2026-09-30")).toEqual({
      startDate: "2026-09-28",
      endDate: "2026-10-04",
      days: [
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
        "2026-10-01",
        "2026-10-02",
        "2026-10-03",
        "2026-10-04",
      ],
    });
    expect(visibleRange("day", "2026-09-30")).toEqual({
      startDate: "2026-09-30",
      endDate: "2026-09-30",
      days: ["2026-09-30"],
    });
  });

  it("moves by a week or a day", () => {
    expect(shiftAnchor("week", "2026-09-30", 1)).toBe("2026-10-07");
    expect(shiftAnchor("day", "2026-09-30", -1)).toBe("2026-09-29");
  });

  it("formats labels and durations", () => {
    expect(periodLabel("week", visibleRange("week", "2026-09-30"))).toBe(
      "28 sept. – 4 oct. 2026",
    );
    expect(periodLabel("day", visibleRange("day", "2026-09-30"))).toBe(
      "Mercredi 30 septembre",
    );
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(75)).toBe("1 h 15");
    expect(formatDuration(120)).toBe("2 h");
  });

  it("converts wall-clock times to minutes and back", () => {
    expect(minutesOf("2026-09-30T14:45")).toBe(885);
    expect(timeFromMinutes(885)).toBe("14:45");
    expect(timeFromMinutes(2000)).toBe("23:59");
  });
});
