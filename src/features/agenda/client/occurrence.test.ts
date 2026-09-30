import { describe, expect, it } from "vitest";

import {
  occurrenceLabel,
  timeWithOccurrence,
  transitionOffsets,
} from "./occurrence";

describe("repeated autumn hour labels", () => {
  it("names both occurrences in understandable terms with their offsets", () => {
    expect(transitionOffsets("2026-10-25", "Europe/Paris")).toEqual({
      before: "UTC+2",
      after: "UTC+1",
    });
    expect(occurrenceLabel("first", "2026-10-25", "Europe/Paris")).toBe(
      "heure d’été (UTC+2)",
    );
    expect(occurrenceLabel("second", "2026-10-25", "Europe/Paris")).toBe(
      "heure d’hiver (UTC+1)",
    );
  });

  it("only decorates ambiguous times", () => {
    expect(
      timeWithOccurrence("02:30", "first", "2026-10-25", "Europe/Paris"),
    ).toBe("02:30 (heure d’été, UTC+2)");
    expect(
      timeWithOccurrence("02:30", "second", "2026-10-25", "Europe/Paris"),
    ).toBe("02:30 (heure d’hiver, UTC+1)");
    expect(
      timeWithOccurrence("10:00", null, "2026-09-29", "Europe/Paris"),
    ).toBe("10:00");
  });
});
