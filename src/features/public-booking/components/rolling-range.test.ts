import { describe, expect, it } from "vitest";

import { rollingRange, shiftRolling } from "./availability-calendar";

// Bookable days from Saturday 21 November 2026, as the flow lists them.
const bookable = Array.from({ length: 20 }, (_, offset) => {
  const day = new Date(Date.UTC(2026, 10, 21 + offset));
  return day.toISOString().slice(0, 10);
});

describe("rollingRange (Chronologique)", () => {
  it("shows the next seven bookable days, not the calendar week", () => {
    // A Saturday: the calendar week would end the next day.
    const range = rollingRange(bookable, "2026-11-21");
    expect(range.days).toEqual(bookable.slice(0, 7));
    expect(range.startDate).toBe("2026-11-21");
    expect(range.endDate).toBe("2026-11-27");
  });

  it("starts at the first bookable day on or after the one asked", () => {
    expect(rollingRange(bookable, "2026-11-01").startDate).toBe("2026-11-21");
  });

  it("keeps seven days at the end of the bookable window", () => {
    const range = rollingRange(bookable, "2026-12-09");
    expect(range.days).toHaveLength(7);
    expect(range.endDate).toBe(bookable.at(-1));
  });

  it("shows what there is when fewer than seven days are bookable", () => {
    expect(rollingRange(bookable.slice(0, 3), "2026-11-21").days).toEqual(
      bookable.slice(0, 3),
    );
  });
});

describe("shiftRolling", () => {
  it("moves by seven days, within the bookable window", () => {
    expect(shiftRolling(bookable, "2026-11-21", 1)).toBe("2026-11-28");
    expect(shiftRolling(bookable, "2026-11-28", -1)).toBe("2026-11-21");
    expect(shiftRolling(bookable, "2026-11-21", -1)).toBe("2026-11-21");
    expect(shiftRolling(bookable, "2026-12-05", 1)).toBe(
      bookable[bookable.length - 7],
    );
  });
});
