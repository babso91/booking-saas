import { describe, expect, it } from "vitest";

import { intlZone } from "../../../../tests/support/zone-fixture";
import { occurrenceLabel, timeWithOccurrence } from "./occurrence";

const paris = intlZone("Europe/Paris", ["2026-10-25", "2026-09-29"]);

describe("repeated autumn hour labels", () => {
  it("names both occurrences in understandable terms with the server's offsets", () => {
    expect(occurrenceLabel("first", "2026-10-25", paris)).toBe(
      "heure d’été (UTC+2)",
    );
    expect(occurrenceLabel("second", "2026-10-25", paris)).toBe(
      "heure d’hiver (UTC+1)",
    );
  });

  it("only decorates ambiguous times", () => {
    expect(timeWithOccurrence("02:30", "first", "2026-10-25", paris)).toBe(
      "02:30 (heure d’été, UTC+2)",
    );
    expect(timeWithOccurrence("02:30", "second", "2026-10-25", paris)).toBe(
      "02:30 (heure d’hiver, UTC+1)",
    );
    expect(timeWithOccurrence("10:00", null, "2026-09-29", paris)).toBe(
      "10:00",
    );
  });

  it("never falls back to the browser's rules for a day the server did not send", () => {
    expect(occurrenceLabel("first", "2027-10-31", paris)).toBe("heure d’été");
    expect(timeWithOccurrence("02:30", "second", "2027-10-31", null)).toBe(
      "02:30 (heure d’hiver)",
    );
  });

  it("formats half-hour offsets (Lord Howe)", () => {
    const lordHowe = intlZone("Australia/Lord_Howe", ["2026-04-05"]);
    expect(occurrenceLabel("first", "2026-04-05", lordHowe)).toBe(
      "heure d’été (UTC+11)",
    );
    expect(occurrenceLabel("second", "2026-04-05", lordHowe)).toBe(
      "heure d’hiver (UTC+10:30)",
    );
  });
});
