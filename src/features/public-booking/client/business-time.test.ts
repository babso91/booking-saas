import { describe, expect, it } from "vitest";

import {
  addDays,
  businessToday,
  dayLabel,
  dayParts,
  wallDate,
  wallTime,
  zoneCity,
} from "./business-time";

describe("business time of the public booking", () => {
  it("today is the business's civil date, not the device's", () => {
    // 05:00 UTC on Oct 16: still Oct 15 in Vancouver, Oct 16 in Paris.
    const now = new Date("2026-10-16T05:00:00Z");
    expect(businessToday("America/Vancouver", now)).toBe("2026-10-15");
    expect(businessToday("Europe/Paris", now)).toBe("2026-10-16");
  });

  it("days are calendar arithmetic: a DST change never shifts a day", () => {
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayLabel("2026-10-25")).toBe("dimanche 25 octobre");
    expect(dayLabel("2026-10-25", true)).toBe("dimanche 25 octobre 2026");
    expect(dayParts("2026-10-25")).toEqual({
      weekday: "dim",
      day: "25",
      month: "oct",
    });
  });

  it("wall clocks are read as given, never converted", () => {
    expect(wallTime("2026-10-25T01:30")).toBe("01:30");
    expect(wallDate("2026-10-25T01:30")).toBe("2026-10-25");
    expect(zoneCity("America/Los_Angeles")).toBe("Los Angeles");
  });
});
