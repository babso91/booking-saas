import { describe, expect, it } from "vitest";

import {
  availabilityQuerySchema,
  createAvailabilityExceptionSchema,
  replaceBusinessHoursSchema,
  updateBookingSettingsSchema,
} from "./availability";

describe("replaceBusinessHoursSchema", () => {
  it("accepts several ranges per day, 24:00 and an empty (closed) week", () => {
    expect(
      replaceBusinessHoursSchema.safeParse({
        hours: [
          { weekday: 1, startsAt: "10:00", endsAt: "13:00" },
          { weekday: 1, startsAt: "13:00", endsAt: "19:00" },
          { weekday: 5, startsAt: "20:00", endsAt: "24:00" },
        ],
      }).success,
    ).toBe(true);
    expect(replaceBusinessHoursSchema.safeParse({ hours: [] }).success).toBe(
      true,
    );
  });

  it.each([
    [
      "overlapping ranges",
      [
        { weekday: 1, startsAt: "10:00", endsAt: "13:00" },
        { weekday: 1, startsAt: "12:59", endsAt: "14:00" },
      ],
    ],
    ["an empty range", [{ weekday: 1, startsAt: "10:00", endsAt: "10:00" }]],
    ["an invalid time", [{ weekday: 1, startsAt: "9:00", endsAt: "10:00" }]],
    ["24:30", [{ weekday: 1, startsAt: "10:00", endsAt: "24:30" }]],
    ["weekday 7", [{ weekday: 7, startsAt: "10:00", endsAt: "11:00" }]],
  ])("rejects %s", (_label, hours) => {
    expect(replaceBusinessHoursSchema.safeParse({ hours }).success).toBe(false);
  });
});

describe("createAvailabilityExceptionSchema", () => {
  it("accepts local wall-clock bounds", () => {
    expect(
      createAvailabilityExceptionSchema.parse({
        kind: "closed",
        startsAt: "2026-12-24T00:00",
        endsAt: "2026-12-27T00:00",
        reason: "",
      }),
    ).toEqual({
      kind: "closed",
      startsAt: "2026-12-24T00:00",
      endsAt: "2026-12-27T00:00",
      reason: null,
    });
  });

  it.each([
    [
      "end before start",
      { startsAt: "2026-12-24T10:00", endsAt: "2026-12-24T09:00" },
    ],
    [
      "an impossible date",
      { startsAt: "2026-02-30T10:00", endsAt: "2026-03-01T10:00" },
    ],
    [
      "an instant with offset",
      { startsAt: "2026-12-24T10:00Z", endsAt: "2026-12-24T11:00" },
    ],
  ])("rejects %s", (_label, bounds) => {
    expect(
      createAvailabilityExceptionSchema.safeParse({
        kind: "blocked",
        ...bounds,
      }).success,
    ).toBe(false);
  });
});

describe("updateBookingSettingsSchema", () => {
  it("accepts partial changes within database bounds", () => {
    expect(
      updateBookingSettingsSchema.safeParse({ bufferMinutes: 15 }).success,
    ).toBe(true);
    expect(updateBookingSettingsSchema.safeParse({}).success).toBe(false);
    expect(
      updateBookingSettingsSchema.safeParse({ bufferMinutes: 241 }).success,
    ).toBe(false);
    expect(
      updateBookingSettingsSchema.safeParse({ slotIntervalMinutes: 7.5 })
        .success,
    ).toBe(false);
  });
});

describe("availabilityQuerySchema", () => {
  it("requires a real local date", () => {
    const base = {
      slug: "studio",
      serviceId: "5b0b7a0e-6c35-4c8a-9a39-3f4d8c1b2a10",
    };

    expect(
      availabilityQuerySchema.safeParse({ ...base, date: "2026-10-05" })
        .success,
    ).toBe(true);
    expect(
      availabilityQuerySchema.safeParse({ ...base, date: "2026-13-05" })
        .success,
    ).toBe(false);
  });
});
