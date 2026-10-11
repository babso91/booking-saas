import { describe, expect, it } from "vitest";

import { requestedDay } from "./requested-day";

describe("requestedDay (?date= of the agenda)", () => {
  it.each([
    ["2026-10-24", "2026-10-24"],
    ["2024-02-29", "2024-02-29"],
    ["2026-02-30", undefined],
    ["2026-13-01", undefined],
    ["24/10/2026", undefined],
    ["2026-10-24T10:00", undefined],
    ["", undefined],
  ])("%s → %s", (value, expected) => {
    expect(requestedDay(value)).toBe(expected);
  });

  it("ignores anything that is not one string", () => {
    expect(requestedDay(undefined)).toBeUndefined();
    expect(requestedDay(["2026-10-24", "2026-10-25"])).toBeUndefined();
  });
});
