import { describe, expect, it } from "vitest";

import { windowsAfter } from "./next-opening";

describe("windowsAfter: where her next slot is looked for (point 60)", () => {
  it("from the day after, in spans the availability route accepts", () => {
    expect(windowsAfter("2026-11-22", "2027-01-31")).toEqual([
      { from: "2026-11-23", through: "2026-12-23" },
      { from: "2026-12-24", through: "2027-01-23" },
      { from: "2027-01-24", through: "2027-01-31" },
    ]);
  });

  it("never past her last bookable day, and nothing after it", () => {
    expect(windowsAfter("2026-11-22", "2026-11-25")).toEqual([
      { from: "2026-11-23", through: "2026-11-25" },
    ]);
    expect(windowsAfter("2026-11-25", "2026-11-25")).toEqual([]);
  });

  it("a long horizon is searched about four months ahead, no further", () => {
    const windows = windowsAfter("2026-11-22", "2027-11-22");
    expect(windows).toHaveLength(4);
    expect(windows.at(-1)).toEqual({
      from: "2027-02-24",
      through: "2027-03-26",
    });
  });
});
