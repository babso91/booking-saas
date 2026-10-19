import { describe, expect, it } from "vitest";

import {
  adjustPointsSchema,
  configureProgramSchema,
  createRewardSchema,
  ledgerPageSchema,
  pointsPerEuroSchema,
  updateRewardSchema,
} from "./loyalty";

const SERVICE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const REQUEST = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("pointsPerEuroSchema", () => {
  // Bounds (0.01 to 100 for a new value) are PostgreSQL's: an unchanged
  // historical value may lie outside them.
  it.each(["0.01", "1", "1.5", "2.25", "0.1234", "100", "999999.9999"])(
    "accepts the shape %s",
    (value) => {
      expect(pointsPerEuroSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(["0", "0.0000", "1e2", "-1", "1,5", "", "0.12345", "1234567"])(
    "refuses %s",
    (value) => {
      expect(pointsPerEuroSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("configureProgramSchema", () => {
  const base = {
    expectedVersion: 1,
    active: true,
    pointsPerCompletedAppointment: 1,
  };

  it("spend mode needs a rate; appointment mode refuses one", () => {
    expect(
      configureProgramSchema.safeParse({ ...base, accrualMode: "spend" })
        .success,
    ).toBe(false);
    expect(
      configureProgramSchema.safeParse({
        ...base,
        accrualMode: "spend",
        pointsPerEuro: "1.5",
      }).success,
    ).toBe(true);
    expect(
      configureProgramSchema.safeParse({
        ...base,
        accrualMode: "appointment",
        pointsPerEuro: "1",
      }).success,
    ).toBe(false);
  });

  it("points per appointment are positive whole numbers (bounds: PostgreSQL)", () => {
    for (const points of [0, 1.5, -3]) {
      expect(
        configureProgramSchema.safeParse({
          ...base,
          accrualMode: "appointment",
          pointsPerCompletedAppointment: points,
        }).success,
      ).toBe(false);
    }
  });

  it("version 0 means: no program yet", () => {
    expect(
      configureProgramSchema.safeParse({
        ...base,
        expectedVersion: 0,
        accrualMode: "appointment",
      }).success,
    ).toBe(true);
  });
});

describe("reward schemas", () => {
  const reward = {
    requestId: REQUEST,
    name: " Soin offert ",
    description: "  ",
    pointsRequired: 100,
    rewardType: "free_service",
    rewardValue: null,
    serviceId: SERVICE,
  };

  it("normalises text and defaults to active", () => {
    expect(createRewardSchema.parse(reward)).toMatchObject({
      name: "Soin offert",
      description: null,
      active: true,
    });
  });

  it.each([
    { rewardType: "free_service", rewardValue: 10 },
    { rewardType: "free_service", serviceId: null },
    { rewardType: "fixed_discount", rewardValue: null, serviceId: null },
    { rewardType: "fixed_discount", rewardValue: 500 },
    { rewardType: "percentage_discount", rewardValue: 101, serviceId: null },
    { rewardType: "percentage_discount", rewardValue: 0, serviceId: null },
    { pointsRequired: 0 },
    { pointsRequired: 1.5 },
    { name: "" },
  ])("refuses an inconsistent reward %#", (override) => {
    expect(
      createRewardSchema.safeParse({ ...reward, ...override }).success,
    ).toBe(false);
  });

  it("an update carries the version it was based on", () => {
    const update = {
      ...reward,
      rewardId: SERVICE,
      active: true,
      expectedVersion: 1,
    };
    expect(updateRewardSchema.safeParse(update).success).toBe(true);
    // A grandfathered value may be sent back unchanged (PostgreSQL decides).
    expect(
      updateRewardSchema.safeParse({
        ...update,
        description: "d".repeat(1500),
        pointsRequired: 3_000_000,
      }).success,
    ).toBe(true);
    expect(
      updateRewardSchema.safeParse({ ...update, expectedVersion: 0 }).success,
    ).toBe(false);
  });
});

describe("adjustPointsSchema", () => {
  const adjust = {
    clientId: SERVICE,
    requestId: REQUEST,
    pointsDelta: -5,
    reason: "Erreur",
  };

  it("needs a non-zero integer and a reason", () => {
    expect(adjustPointsSchema.safeParse(adjust).success).toBe(true);
    for (const override of [
      { pointsDelta: 0 },
      { pointsDelta: 1.5 },
      { pointsDelta: 100_001 },
      { reason: "   " },
    ]) {
      expect(
        adjustPointsSchema.safeParse({ ...adjust, ...override }).success,
      ).toBe(false);
    }
  });
});

describe("ledgerPageSchema", () => {
  it("accepts only a positive integer cursor", () => {
    expect(
      ledgerPageSchema.parse({ clientId: SERVICE, cursor: "42" }),
    ).toMatchObject({ cursor: "42", limit: 50 });
    for (const cursor of ["0", "-1", "1.5", "abc", "01"]) {
      expect(
        ledgerPageSchema.safeParse({ clientId: SERVICE, cursor }).success,
      ).toBe(false);
    }
  });
});
