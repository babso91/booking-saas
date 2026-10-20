import { describe, expect, it } from "vitest";

import {
  configureProgramSchema,
  createRewardSchema,
  updateRewardSchema,
} from "../schemas/loyalty";
import type { LoyaltyProgramDto, RewardDto } from "../types";
import {
  activationCommand,
  checkProgram,
  parseRate,
  programCommand,
  programDirty,
  programDraft,
  spendPoints,
} from "./program-form";
import {
  EMPTY_REWARD,
  checkReward,
  createCommand,
  rewardDraft,
  toggleCommand,
  updateCommand,
} from "./reward-form";

const program = (
  overrides: Partial<LoyaltyProgramDto> = {},
): LoyaltyProgramDto => ({
  active: true,
  accrualMode: "appointment",
  pointsPerCompletedAppointment: 10,
  pointsPerEuro: null,
  version: 3,
  serviceRules: [],
  ...overrides,
});

const reward = (overrides: Partial<RewardDto> = {}): RewardDto => ({
  id: "40000000-0000-4000-8000-000000000001",
  name: "Remise fidélité",
  description: null,
  pointsRequired: 100,
  rewardType: "fixed_discount",
  rewardValue: 500,
  currency: "EUR",
  serviceId: null,
  active: true,
  version: 2,
  ...overrides,
});

describe("program form", () => {
  it("reads a rate typed in French or English as an exact decimal string", () => {
    expect(parseRate("1,5")).toBe("1.5");
    expect(parseRate(" 0.50 ")).toBe("0.5");
    expect(parseRate("2")).toBe("2");
    expect(parseRate("007,2500")).toBe("7.25");
    expect(parseRate("0")).toBeNull();
    expect(parseRate("1,23456")).toBeNull();
    expect(parseRate("-1")).toBeNull();
    expect(parseRate("1e2")).toBeNull();
  });

  it("previews spend points with integer arithmetic, rounded down like PostgreSQL", () => {
    expect(spendPoints(6500, "1")).toBe(65);
    expect(spendPoints(6500, "0.5")).toBe(32);
    expect(spendPoints(6550, "1.5")).toBe(98); // 98.25
    expect(spendPoints(10, "0.01")).toBe(0);
    // 0.1 + 0.2 style errors cannot happen: 3 × 0.1 × 100 cents.
    expect(spendPoints(300, "0.1")).toBe(0);
    expect(spendPoints(3000, "0.1")).toBe(3);
  });

  it("sends a historical out-of-bounds value back unchanged, and refuses a new one", () => {
    const historical = program({
      accrualMode: "spend",
      pointsPerCompletedAppointment: 50_000,
      pointsPerEuro: "250",
    });
    const untouched = checkProgram(programDraft(historical), historical);
    expect(untouched).toEqual({
      ok: true,
      pointsPerCompletedAppointment: 50_000,
      pointsPerEuro: "250",
    });

    const changed = checkProgram(
      { ...programDraft(historical), perEuro: "300" },
      historical,
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.errors.perEuro).toMatch(/0,01 et 100/);
  });

  it("requires a rate in spend mode and drops it in appointment mode", () => {
    const base = program();
    const spend = checkProgram(
      { ...programDraft(base), accrualMode: "spend", perEuro: "" },
      base,
    );
    expect(spend.ok).toBe(false);

    const back = program({ accrualMode: "spend", pointsPerEuro: "1.5" });
    const draft = {
      ...programDraft(back),
      accrualMode: "appointment" as const,
    };
    const checked = checkProgram(draft, back);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const command = programCommand(
      back,
      { active: true, accrualMode: "appointment" },
      checked,
    );
    expect(command.pointsPerEuro).toBeNull();
    expect(command.expectedVersion).toBe(3);
    expect(configureProgramSchema.safeParse(command).success).toBe(true);
  });

  it("knows when the draft differs from the program as read", () => {
    const base = program({ accrualMode: "spend", pointsPerEuro: "1.5" });
    expect(programDirty(programDraft(base), base)).toBe(false);
    expect(programDirty({ ...programDraft(base), perEuro: "1.50" }, base)).toBe(
      false,
    );
    expect(programDirty({ ...programDraft(base), perEuro: "2" }, base)).toBe(
      true,
    );
    expect(
      programDirty({ ...programDraft(base), accrualMode: "appointment" }, base),
    ).toBe(true);
  });

  it("activates the saved configuration, valid for the real schema, from version 0", () => {
    const fresh = program({ active: false, version: 0 });
    const command = activationCommand(fresh, true);
    expect(command).toEqual({
      expectedVersion: 0,
      active: true,
      accrualMode: "appointment",
      pointsPerCompletedAppointment: 10,
      pointsPerEuro: null,
    });
    expect(configureProgramSchema.safeParse(command).success).toBe(true);
  });
});

describe("reward form", () => {
  it("keeps a historical name and description byte for byte when they are not edited", () => {
    const historical = reward({
      name: "  Remise   d’antan ",
      description: `${"x".repeat(1500)}  `,
      pointsRequired: 2_000_000,
    });
    const draft = { ...rewardDraft(historical), points: "1500" };
    const checked = checkReward(draft, historical);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const command = updateCommand(
      historical,
      checked.values,
      historical.active,
    );
    expect(command.name).toBe("  Remise   d’antan ");
    expect(command.description).toBe(`${"x".repeat(1500)}  `);
    expect(command.pointsRequired).toBe(1500);
    expect(updateRewardSchema.safeParse(command).success).toBe(true);
  });

  it("passes historical out-of-bounds numbers through, and bounds only what changed", () => {
    const historical = reward({
      rewardType: "percentage_discount",
      rewardValue: 150,
      currency: null,
      pointsRequired: 5_000_000,
    });
    const untouched = checkReward(rewardDraft(historical), historical);
    expect(untouched).toMatchObject({
      ok: true,
      values: { rewardValue: 150, pointsRequired: 5_000_000 },
    });

    const edited = checkReward(
      { ...rewardDraft(historical), value: "120" },
      historical,
    );
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.errors.value).toMatch(/1 à 100/);
  });

  it("trims a name or description the professional changed", () => {
    const base = reward({ description: "Ancienne" });
    const checked = checkReward(
      { ...rewardDraft(base), name: "  Nouveau nom ", description: "   " },
      base,
    );
    expect(checked).toMatchObject({
      ok: true,
      values: { name: "Nouveau nom", description: null },
    });
  });

  it("reads euros without floating point and builds a valid creation", () => {
    const draft = {
      ...EMPTY_REWARD,
      name: "Remise",
      points: "50",
      value: "7,50",
    };
    const checked = checkReward(draft, null);
    expect(checked).toMatchObject({ ok: true, values: { rewardValue: 750 } });
    if (!checked.ok) return;
    const command = createCommand(
      draft,
      checked.values,
      "50000000-0000-4000-8000-000000000001",
    );
    expect(createRewardSchema.safeParse(command).success).toBe(true);
  });

  it("requires a service for a free service, never a value", () => {
    const draft = {
      ...EMPTY_REWARD,
      name: "Offert",
      points: "80",
      rewardType: "free_service" as const,
      value: "12",
    };
    expect(checkReward(draft, null)).toMatchObject({
      ok: false,
      errors: { serviceId: expect.any(String) },
    });
    const checked = checkReward(
      { ...draft, serviceId: "30000000-0000-4000-8000-000000000001" },
      null,
    );
    expect(checked).toMatchObject({ ok: true, values: { rewardValue: null } });
  });

  it("toggles activation with every other field as stored", () => {
    const historical = reward({
      name: " Brut ",
      description: "  ",
      pointsRequired: 3_000_000,
    });
    const command = toggleCommand(historical);
    expect(command).toMatchObject({
      name: " Brut ",
      description: "  ",
      pointsRequired: 3_000_000,
      active: false,
      expectedVersion: 2,
    });
    expect(updateRewardSchema.safeParse(command).success).toBe(true);
    // A historical free service without service cannot be saved as is.
    expect(
      toggleCommand(
        reward({
          rewardType: "free_service",
          rewardValue: null,
          serviceId: null,
        }),
      ),
    ).toBeNull();
  });
});
