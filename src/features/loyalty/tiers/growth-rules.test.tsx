// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { growthRulesSchema } from "@/features/loyalty/growth/schemas";

import { GrowthRules } from "./growth-rules";

// Her tiers and referral rules, with the Server Actions mocked at their
// boundary; every command sent is checked against the action's schema.

const { actions } = vi.hoisted(() => ({
  actions: {
    getLoyaltyGrowthRulesAction: vi.fn(),
    setLoyaltyGrowthRulesAction: vi.fn(),
  },
}));
vi.mock("@/features/loyalty/growth/actions", () => ({
  getLoyaltyGrowthRulesAction: (...args: unknown[]) =>
    actions.getLoyaltyGrowthRulesAction(...args),
  setLoyaltyGrowthRulesAction: (...args: unknown[]) =>
    actions.setLoyaltyGrowthRulesAction(...args),
}));

const empty = { tiers: [], windowDays: 365, referralPoints: null, version: 0 };

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(cleanup);

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

describe("GrowthRules", () => {
  it("adds tiers and referral, and sends them as one versioned set", async () => {
    actions.getLoyaltyGrowthRulesAction.mockResolvedValue({
      ok: true,
      data: empty,
    });
    actions.setLoyaltyGrowthRulesAction.mockImplementation(async (input) => {
      const command = growthRulesSchema.parse(input);
      return {
        ok: true,
        data: {
          tiers: command.tiers.map((tier) => ({
            id: `t${tier.threshold}`,
            name: tier.name,
            threshold: tier.threshold,
            perk: tier.perk ?? null,
          })),
          windowDays: command.windowDays,
          referralPoints: command.referralPoints,
          version: 1,
        },
      };
    });
    render(<GrowthRules />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Ajouter un niveau" }),
    );
    fireEvent.change(screen.getByLabelText("Nom du niveau 1"), {
      target: { value: "Or" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Parrainage proposé" }));
    save();
    expect(await screen.findByText("Enregistré")).toBeTruthy();
    expect(actions.setLoyaltyGrowthRulesAction).toHaveBeenCalledWith({
      tiers: [{ name: "Or", threshold: 3, perk: null }],
      windowDays: 365,
      referralPoints: 50,
      expectedVersion: 0,
    });
  });

  it("refuses thresholds that do not grow, before sending anything", async () => {
    actions.getLoyaltyGrowthRulesAction.mockResolvedValue({
      ok: true,
      data: {
        ...empty,
        version: 2,
        tiers: [
          { id: "t3", name: "Argent", threshold: 3, perk: null },
          { id: "t6", name: "Or", threshold: 6, perk: null },
        ],
      },
    });
    render(<GrowthRules />);
    fireEvent.change(await screen.findByLabelText("Visites pour le niveau 2"), {
      target: { value: "2" },
    });
    save();
    expect(
      await screen.findByText(
        "Chaque niveau demande plus de visites que le précédent.",
      ),
    ).toBeTruthy();
    expect(actions.setLoyaltyGrowthRulesAction).not.toHaveBeenCalled();
  });

  it("says a version changed elsewhere, and overwrites nothing", async () => {
    actions.getLoyaltyGrowthRulesAction.mockResolvedValue({
      ok: true,
      data: empty,
    });
    actions.setLoyaltyGrowthRulesAction.mockResolvedValue({
      ok: false,
      error: { code: "version_conflict", message: "never shown" },
    });
    render(<GrowthRules />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Ajouter un niveau" }),
    );
    fireEvent.change(screen.getByLabelText("Nom du niveau 1"), {
      target: { value: "Or" },
    });
    save();
    expect(
      await screen.findByText(/modifiées ailleurs\. Rien n’a été enregistré/),
    ).toBeTruthy();
  });
});
