import { describe, expect, it } from "vitest";

import { earliestOf, nextLabel, nextSlotsOf } from "./next-slot";

const slot = (local: string, startsAt: string) => ({
  startsAt,
  endsAt: startsAt,
  localStartsAt: local,
  localEndsAt: local,
});

describe("her next slots", () => {
  const rows = [
    {
      serviceId: "a",
      slot: slot("2026-11-24T10:00", "2026-11-24T09:00:00.000Z"),
    },
    { serviceId: "b", slot: null },
    {
      serviceId: "c",
      slot: slot("2026-11-23T15:30", "2026-11-23T14:30:00.000Z"),
    },
  ];

  it("keeps the services that have one", () => {
    expect(Object.keys(nextSlotsOf(rows))).toEqual(["a", "c"]);
    expect(nextSlotsOf(null)).toEqual({});
  });

  it("her next availability is the earliest instant, whatever the order", () => {
    expect(earliestOf(nextSlotsOf(rows))?.localStartsAt).toBe(
      "2026-11-23T15:30",
    );
    expect(earliestOf({})).toBeNull();
  });
});

describe("nextLabel", () => {
  it("says today and tomorrow plainly, by her calendar", () => {
    expect(nextLabel("2026-11-21T15:30", "2026-11-21")).toBe(
      "Aujourd’hui à 15:30",
    );
    expect(nextLabel("2026-11-22T10:00", "2026-11-21")).toBe("Demain à 10:00");
  });

  it("then the day, short", () => {
    expect(nextLabel("2026-11-24T10:00", "2026-11-21")).toBe(
      "mar. 24 nov. à 10:00",
    );
  });
});
