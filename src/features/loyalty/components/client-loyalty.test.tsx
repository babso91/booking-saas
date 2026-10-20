// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adjustPointsSchema,
  cancelRedemptionSchema,
  fulfilRedemptionSchema,
  ledgerPageSchema,
  redeemRewardSchema,
  reverseAdjustmentSchema,
} from "../schemas/loyalty";
import type {
  ClientLoyaltySummaryDto,
  LoyaltyLedgerEntryDto,
  RedemptionDto,
  RewardDto,
} from "../types";
import { points } from "../client/format";
import { ClientLoyalty } from "./client-loyalty";

// Loyalty in a customer's file, from what the professional sees and does.
// The Server Actions are mocked at their module boundary with their real
// result shapes; every command is checked against the real zod schema.

const { actions } = vi.hoisted(() => ({
  actions: {
    getClientLoyaltyAction: vi.fn(),
    listRewardsAction: vi.fn(),
    listClientRedemptionsAction: vi.fn(),
    listClientLoyaltyLedgerAction: vi.fn(),
    redeemRewardAction: vi.fn(),
    fulfilRedemptionAction: vi.fn(),
    cancelRedemptionAction: vi.fn(),
    adjustPointsAction: vi.fn(),
    reverseAdjustmentAction: vi.fn(),
  },
}));
vi.mock("@/features/loyalty/actions/loyalty", () =>
  Object.fromEntries(
    Object.keys(actions).map((name) => [
      name,
      (...args: unknown[]) =>
        (actions as Record<string, (...a: unknown[]) => unknown>)[name]!(
          ...args,
        ),
    ]),
  ),
);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, fieldErrors?: Record<string, string[]>) => ({
  ok: false as const,
  error: { code, message: "backend text never shown", fieldErrors },
});
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

const CLIENT = "20000000-0000-4000-8000-000000000001";
const REWARD = "40000000-0000-4000-8000-000000000001";
const OTHER_REWARD = "40000000-0000-4000-8000-000000000002";
const VISIT = "60000000-0000-4000-8000-000000000001";

const rewards: RewardDto[] = [
  {
    id: REWARD,
    name: "Remise 5 €",
    description: "Sur toute prestation.",
    pointsRequired: 50,
    rewardType: "fixed_discount",
    rewardValue: 500,
    currency: "EUR",
    serviceId: null,
    active: true,
    version: 1,
  },
  {
    id: OTHER_REWARD,
    name: "Remplissage offert",
    description: null,
    pointsRequired: 200,
    rewardType: "free_service",
    rewardValue: null,
    currency: null,
    serviceId: "30000000-0000-4000-8000-000000000001",
    active: true,
    version: 1,
  },
];

const summary = (
  overrides: Partial<ClientLoyaltySummaryDto> = {},
): ClientLoyaltySummaryDto => {
  const balance = overrides.balance ?? 120;
  return {
    clientId: CLIENT,
    programActive: true,
    balance,
    pointsCredited: 170,
    pointsDebited: 50,
    issuedRedemptions: 0,
    rewards: rewards.map((reward) => ({
      rewardId: reward.id,
      pointsRequired: reward.pointsRequired,
      eligible:
        (overrides.programActive ?? true) && balance >= reward.pointsRequired,
      missingPoints: Math.max(0, reward.pointsRequired - balance),
      unavailableReason:
        (overrides.programActive ?? true) ? null : "program_inactive",
    })),
    ...overrides,
  };
};

const redemption = (overrides: Partial<RedemptionDto> = {}): RedemptionDto => ({
  id: "70000000-0000-4000-8000-000000000001",
  rewardId: REWARD,
  clientId: CLIENT,
  status: "issued",
  pointsSpent: 50,
  reward: {
    name: "Remise 5 €",
    type: "fixed_discount",
    value: 500,
    currency: "EUR",
    serviceId: null,
    serviceName: null,
  },
  redeemedAt: "2026-10-12T12:30:00Z",
  fulfilledAt: null,
  appointmentId: null,
  cancelledAt: null,
  cancellationReason: null,
  debitEntryId: "80000000-0000-4000-8000-000000000001",
  refundEntryId: null,
  ...overrides,
});

const entry = (
  index: number,
  overrides: Partial<LoyaltyLedgerEntryDto> = {},
): LoyaltyLedgerEntryDto => ({
  id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  type: "appointment_completed",
  pointsDelta: 10,
  balanceAfter: 10 * index,
  reason: "Rendez-vous terminé",
  appointmentId: null,
  reversesEntryId: null,
  reversedByEntryId: null,
  awardGeneration: 1,
  details: {},
  createdAt: "2026-10-10T08:00:00Z",
  createdBy: null,
  redemption: null,
  ...overrides,
});

// The signed-in identity and this customer (pending operations).
const SCOPE = {
  userId: "10000000-0000-4000-8000-0000000000aa",
  businessId: "10000000-0000-4000-8000-0000000000bb",
  clientId: CLIENT,
};

async function renderCard({
  loyalty = summary(),
  redemptions = [] as RedemptionDto[],
  onChanged = vi.fn(),
  scope = SCOPE,
} = {}) {
  actions.getClientLoyaltyAction.mockResolvedValue(ok(loyalty));
  actions.listRewardsAction.mockResolvedValue(ok(rewards));
  actions.listClientRedemptionsAction.mockResolvedValue(ok(redemptions));
  const view = render(
    <ClientLoyalty
      scope={scope}
      timezone="Europe/Paris"
      visits={[{ id: VISIT, label: "sam. 10 oct. · 10:00 · Remplissage" }]}
      onChanged={onChanged}
    />,
  );
  await flush();
  return { ...view, onChanged };
}

const card = () => within(screen.getByRole("region", { name: "Fidélité" }));
const sheet = () => within(screen.getAllByRole("dialog").at(-1)!);
const lastCall = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("summary", () => {
  it("shows the balance, totals and that nothing was redeemed yet", async () => {
    await renderCard();
    expect(card().getByText("120 points")).toBeTruthy();
    expect(
      card().getByText("170 points gagnés · 50 points dépensés"),
    ).toBeTruthy();
    expect(card().getByText("Aucune pour l’instant.")).toBeTruthy();
    expect(
      card().getByText("1 récompense accessible avec ce solde."),
    ).toBeTruthy();
  });

  it("explains a customer without any movement", async () => {
    await renderCard({
      loyalty: summary({ balance: 0, pointsCredited: 0, pointsDebited: 0 }),
    });
    expect(
      card().getByText("Aucun mouvement de points pour l’instant."),
    ).toBeTruthy();
  });

  it("shows a negative balance and allows no new spending", async () => {
    await renderCard({ loyalty: summary({ balance: -10 }) });
    expect(card().getByText("−10 points")).toBeTruthy();
    expect(card().getByText("Solde négatif")).toBeTruthy();
    fireEvent.click(
      card().getByRole("button", { name: /Attribuer une récompense/ }),
    );
    const options = sheet().getAllByRole("radio") as HTMLInputElement[];
    options.forEach((option) => expect(option.disabled).toBe(true));
    // Missing points counted from the signed balance: 50 − (−10).
    expect(sheet().getByText("Il manque 60 points")).toBeTruthy();
  });

  it("with the program inactive, keeps the balance readable and blocks rewards", async () => {
    await renderCard({ loyalty: summary({ programActive: false }) });
    expect(card().getByText("120 points")).toBeTruthy();
    expect(
      card().getByText(/aucune récompense ne peut\s+être attribuée/),
    ).toBeTruthy();
    expect(
      (
        card().getByRole("button", {
          name: /Attribuer une récompense/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows a read failure with a retry, not a zero balance", async () => {
    actions.getClientLoyaltyAction.mockResolvedValue(fail("forbidden"));
    actions.listRewardsAction.mockResolvedValue(ok(rewards));
    actions.listClientRedemptionsAction.mockResolvedValue(ok([]));
    render(
      <ClientLoyalty
        scope={SCOPE}
        timezone="Europe/Paris"
        visits={[]}
        onChanged={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getByText(/n’a pas pu être chargée/)).toBeTruthy();
    expect(screen.queryByText(/0 point/)).toBeNull();
  });
});

describe("issuing a reward", () => {
  async function review() {
    fireEvent.click(
      card().getByRole("button", { name: /Attribuer une récompense/ }),
    );
    fireEvent.click(sheet().getByLabelText(/Remise 5 €/));
    fireEvent.click(sheet().getByRole("button", { name: "Continuer" }));
  }

  it("shows cost and balance after before confirming, then shows success only once confirmed", async () => {
    const { onChanged } = await renderCard();
    await review();
    expect(sheet().getByText("Confirmer l’attribution")).toBeTruthy();
    expect(sheet().getByText("70 points")).toBeTruthy(); // balance after
    expect(
      sheet().getByText(/rien n’est\s+déduit automatiquement/),
    ).toBeTruthy();
    expect(actions.redeemRewardAction).not.toHaveBeenCalled();

    const answer = deferred<unknown>();
    actions.redeemRewardAction.mockReturnValue(answer.promise);
    const confirm = sheet().getByRole("button", {
      name: /Attribuer \(−50 points\)/,
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(actions.redeemRewardAction).toHaveBeenCalledTimes(1);
    const command = lastCall(actions.redeemRewardAction);
    expect(command).toMatchObject({ clientId: CLIENT, rewardId: REWARD });
    expect(redeemRewardSchema.safeParse(command).success).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText(/Récompense attribuée/)).toBeNull();

    actions.getClientLoyaltyAction.mockResolvedValue(
      ok(summary({ balance: 70 })),
    );
    actions.listClientRedemptionsAction.mockResolvedValue(ok([redemption()]));
    answer.resolve(ok(redemption()));
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(card().getByText(/Récompense attribuée : Remise 5 €/)).toBeTruthy();
    expect(card().getByText("70 points")).toBeTruthy();
    expect(card().getByText("À utiliser")).toBeTruthy();
  });

  it("reuses the requestId after a lost answer, even once the card is remounted", async () => {
    const { unmount } = await renderCard();
    await review();
    actions.redeemRewardAction.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(sheet().getByRole("button", { name: /Attribuer \(/ }));
    await flush();
    expect(sheet().getByText(/marquée non confirmée/)).toBeTruthy();
    const first = lastCall(actions.redeemRewardAction).requestId;

    // The dossier tab is left and opened again (phones).
    unmount();
    await renderCard();
    await review();
    actions.redeemRewardAction.mockResolvedValue(ok(redemption()));
    fireEvent.click(sheet().getByRole("button", { name: /Attribuer \(/ }));
    await flush();
    expect(lastCall(actions.redeemRewardAction).requestId).toBe(first);
  });

  it("refreshes eligibility after insufficient_points and debits nothing", async () => {
    await renderCard();
    await review();
    actions.redeemRewardAction.mockResolvedValue(fail("insufficient_points"));
    actions.getClientLoyaltyAction.mockResolvedValue(
      ok(summary({ balance: 20 })),
    );
    fireEvent.click(sheet().getByRole("button", { name: /Attribuer \(/ }));
    await flush();
    expect(sheet().getByText("Solde insuffisant")).toBeTruthy();
    expect(sheet().getByText(/Aucun point n’a été débité/)).toBeTruthy();
    expect(actions.getClientLoyaltyAction).toHaveBeenCalledTimes(2);
    fireEvent.click(sheet().getByRole("button", { name: "Choisir à nouveau" }));
    expect(
      (sheet().getByLabelText(/Remise 5 €/) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("after idempotency_conflict, sends a new request only on her explicit choice", async () => {
    await renderCard();
    await review();
    actions.redeemRewardAction.mockResolvedValueOnce(
      fail("idempotency_conflict"),
    );
    fireEvent.click(sheet().getByRole("button", { name: /Attribuer \(/ }));
    await flush();
    expect(actions.redeemRewardAction).toHaveBeenCalledTimes(1);
    expect(sheet().getByText("Demande déjà utilisée")).toBeTruthy();
    expect(
      (
        sheet().getByRole("button", {
          name: /Attribuer \(/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    actions.redeemRewardAction.mockResolvedValueOnce(ok(redemption()));
    fireEvent.click(
      sheet().getByRole("button", { name: "Envoyer comme nouvelle demande" }),
    );
    await flush();
    const [first, second] = actions.redeemRewardAction.mock.calls.map(
      ([command]) => (command as { requestId: string }).requestId,
    );
    expect(second).not.toBe(first);
  });

  it("explains a reward that became unavailable", async () => {
    await renderCard();
    await review();
    actions.redeemRewardAction.mockResolvedValue(fail("reward_unavailable"));
    fireEvent.click(sheet().getByRole("button", { name: /Attribuer \(/ }));
    await flush();
    expect(sheet().getByText("Récompense indisponible")).toBeTruthy();
  });
});

describe("adjusting points", () => {
  async function fill(
    direction: "Créditer" | "Débiter",
    amount: string,
    reason: string,
  ) {
    fireEvent.click(card().getByRole("button", { name: "Ajuster les points" }));
    fireEvent.click(sheet().getByLabelText(new RegExp(direction)));
    fireEvent.change(sheet().getByLabelText("Nombre de points"), {
      target: { value: amount },
    });
    fireEvent.change(sheet().getByLabelText(/^Motif/), {
      target: { value: reason },
    });
    fireEvent.click(sheet().getByRole("button", { name: "Vérifier" }));
  }

  it("requires a reason and refuses a debit below zero before sending", async () => {
    await renderCard();
    await fill("Débiter", "200", "");
    expect(sheet().getByText(/Au plus 120 points/)).toBeTruthy();
    expect(sheet().getByText(/Indique le motif/)).toBeTruthy();
    expect(actions.adjustPointsAction).not.toHaveBeenCalled();
  });

  it("reviews the balance before and after, then credits", async () => {
    const { onChanged } = await renderCard();
    await fill("Créditer", "30", "Geste commercial");
    expect(sheet().getByText("120 points → 150 points")).toBeTruthy();
    actions.adjustPointsAction.mockResolvedValue(ok({ entryId: entry(1).id }));
    fireEvent.click(
      sheet().getByRole("button", { name: "Créditer 30 points" }),
    );
    await flush();
    const command = lastCall(actions.adjustPointsAction);
    expect(command).toMatchObject({
      clientId: CLIENT,
      pointsDelta: 30,
      reason: "Geste commercial",
    });
    expect(adjustPointsSchema.safeParse(command).success).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(card().getByText("30 points crédités.")).toBeTruthy();
  });

  it("uses a new requestId only when the content changes", async () => {
    await renderCard();
    await fill("Créditer", "30", "Geste");
    actions.adjustPointsAction.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(
      sheet().getByRole("button", { name: "Créditer 30 points" }),
    );
    await flush();
    fireEvent.click(
      sheet().getByRole("button", { name: "Créditer 30 points" }),
    );
    await flush();
    fireEvent.click(sheet().getByRole("button", { name: "Modifier" }));
    fireEvent.change(sheet().getByLabelText("Nombre de points"), {
      target: { value: "40" },
    });
    fireEvent.click(sheet().getByRole("button", { name: "Vérifier" }));
    actions.adjustPointsAction.mockResolvedValue(ok({ entryId: entry(1).id }));
    fireEvent.click(
      sheet().getByRole("button", { name: "Créditer 40 points" }),
    );
    await flush();
    const ids = actions.adjustPointsAction.mock.calls.map(
      ([command]) => (command as { requestId: string }).requestId,
    );
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});

describe("issued rewards", () => {
  it("marks a reward as used, optionally at a visit, after confirmation", async () => {
    const { onChanged } = await renderCard({ redemptions: [redemption()] });
    fireEvent.click(
      card().getByRole("button", {
        name: "Marquer « Remise 5 € » comme utilisée",
      }),
    );
    expect(sheet().getByText(/Aucun paiement n’est enregistré/)).toBeTruthy();
    fireEvent.change(sheet().getByLabelText("Lors de quel rendez-vous ?"), {
      target: { value: VISIT },
    });
    actions.fulfilRedemptionAction.mockResolvedValue(
      ok(
        redemption({
          status: "fulfilled",
          fulfilledAt: "2026-10-12T13:00:00Z",
        }),
      ),
    );
    actions.listClientRedemptionsAction.mockResolvedValue(
      ok([
        redemption({
          status: "fulfilled",
          fulfilledAt: "2026-10-12T13:00:00Z",
        }),
      ]),
    );
    fireEvent.click(
      sheet().getByRole("button", { name: "Marquer comme utilisée" }),
    );
    await flush();
    const command = lastCall(actions.fulfilRedemptionAction);
    expect(command).toEqual({
      redemptionId: redemption().id,
      appointmentId: VISIT,
    });
    expect(fulfilRedemptionSchema.safeParse(command).success).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(card().getByText("Utilisée")).toBeTruthy();
  });

  it("cancels a reward with the points returned shown first", async () => {
    await renderCard({ redemptions: [redemption()] });
    fireEvent.click(
      card().getByRole("button", { name: "Annuler « Remise 5 € »" }),
    );
    expect(
      sheet().getByText(/son solde passe de 120 points à 170 points/),
    ).toBeTruthy();
    fireEvent.change(sheet().getByLabelText(/^Motif/), {
      target: { value: "Erreur" },
    });
    actions.cancelRedemptionAction.mockResolvedValue(
      ok(redemption({ status: "cancelled" })),
    );
    fireEvent.click(
      sheet().getByRole("button", { name: "Annuler la récompense" }),
    );
    await flush();
    const command = lastCall(actions.cancelRedemptionAction);
    expect(command).toEqual({
      redemptionId: redemption().id,
      reason: "Erreur",
    });
    expect(cancelRedemptionSchema.safeParse(command).success).toBe(true);
    expect(card().getByText(/annulée : 50 points rendus/)).toBeTruthy();
  });

  it("says when the reward was already used elsewhere, and re-reads", async () => {
    const { onChanged } = await renderCard({ redemptions: [redemption()] });
    fireEvent.click(
      card().getByRole("button", { name: "Annuler « Remise 5 € »" }),
    );
    actions.cancelRedemptionAction.mockResolvedValue(
      fail("invalid_redemption_transition"),
    );
    fireEvent.click(
      sheet().getByRole("button", { name: "Annuler la récompense" }),
    );
    await flush();
    expect(sheet().getByText("Déjà traitée")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(sheet().getByRole("button", { name: "Relire la fiche" }));
    await flush();
    expect(actions.getClientLoyaltyAction).toHaveBeenCalledTimes(2);
  });
});

describe("history", () => {
  it("reads the whole ledger page by page with the cursor, past 100 entries", async () => {
    await renderCard();
    const pages = [0, 1, 2, 3, 4].map((page) =>
      ok({
        entries: Array.from({ length: 25 }, (_, index) =>
          entry(page * 25 + index + 1),
        ),
        nextCursor: page < 4 ? String(1000 - page * 25) : null,
      }),
    );
    pages.forEach((page) =>
      actions.listClientLoyaltyLedgerAction.mockResolvedValueOnce(page),
    );
    fireEvent.click(
      card().getByRole("button", { name: "Historique des points" }),
    );
    await flush();
    expect(sheet().getAllByRole("listitem")).toHaveLength(25);
    for (let page = 1; page < 5; page += 1) {
      fireEvent.click(
        sheet().getByRole("button", {
          name: "Afficher les opérations plus anciennes",
        }),
      );
      await flush();
    }
    expect(sheet().getAllByRole("listitem")).toHaveLength(125);
    expect(
      sheet().getByText("Début de l’historique (125 opérations)."),
    ).toBeTruthy();
    const calls = actions.listClientLoyaltyLedgerAction.mock.calls.map(
      ([input]) => input as { cursor?: string },
    );
    expect(calls.map((input) => input.cursor)).toEqual([
      undefined,
      "1000",
      "975",
      "950",
      "925",
    ]);
    calls.forEach((input) =>
      expect(ledgerPageSchema.safeParse(input).success).toBe(true),
    );
  });

  it("labels earnings, spending and corrections, and cancels a manual adjustment", async () => {
    const adjustment = entry(3, {
      type: "manual_adjustment",
      pointsDelta: 20,
      reason: "Geste commercial",
    });
    const corrected = entry(2, { reversedByEntryId: entry(4).id });
    const correction = entry(4, {
      type: "correction",
      pointsDelta: -10,
      reason: "Rendez-vous rouvert",
      reversesEntryId: corrected.id,
    });
    const spent = entry(5, {
      type: "reward_redeemed",
      pointsDelta: -50,
      reason: "Récompense",
      redemption: {
        id: redemption().id,
        rewardId: REWARD,
        rewardName: "Remise 5 €",
        rewardType: "fixed_discount",
        rewardValue: 500,
        currency: "EUR",
        serviceId: null,
        serviceName: null,
        pointsSpent: 50,
        status: "issued",
        redeemedAt: "2026-10-12T12:30:00Z",
        fulfilledAt: null,
        appointmentId: null,
        cancelledAt: null,
        cancellationReason: null,
      },
    });
    const { onChanged } = await renderCard();
    actions.listClientLoyaltyLedgerAction.mockResolvedValue(
      ok({
        entries: [spent, correction, adjustment, corrected],
        nextCursor: null,
      }),
    );
    fireEvent.click(
      card().getByRole("button", { name: "Historique des points" }),
    );
    await flush();
    expect(sheet().getByText("Récompense attribuée : Remise 5 €")).toBeTruthy();
    expect(sheet().getByText("Correction")).toBeTruthy();
    expect(sheet().getByText(/Annule : Rendez-vous terminé/)).toBeTruthy();
    expect(sheet().getByText("Annulé")).toBeTruthy();
    // Only the uncompensated manual adjustment can be cancelled here.
    const cancel = sheet().getAllByRole("button", {
      name: "Annuler cet ajustement",
    });
    expect(cancel).toHaveLength(1);

    fireEvent.click(cancel[0]!);
    expect(
      sheet().getByText(/son solde passe de 120 points à 100 points/),
    ).toBeTruthy();
    actions.reverseAdjustmentAction.mockResolvedValue(
      ok({ entryId: entry(6).id }),
    );
    fireEvent.click(
      sheet().getByRole("button", { name: "Annuler l’ajustement" }),
    );
    await flush();
    const command = lastCall(actions.reverseAdjustmentAction);
    expect(command).toEqual({ entryId: adjustment.id, reason: null });
    expect(reverseAdjustmentSchema.safeParse(command).success).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses to cancel a credit that was already spent", async () => {
    await renderCard({ loyalty: summary({ balance: 5 }) });
    actions.listClientLoyaltyLedgerAction.mockResolvedValue(
      ok({
        entries: [
          entry(1, {
            type: "manual_adjustment",
            pointsDelta: 20,
            reason: "Bonus",
          }),
        ],
        nextCursor: null,
      }),
    );
    fireEvent.click(
      card().getByRole("button", { name: "Historique des points" }),
    );
    await flush();
    fireEvent.click(
      sheet().getByRole("button", { name: "Annuler cet ajustement" }),
    );
    expect(sheet().getByText("Solde insuffisant")).toBeTruthy();
    fireEvent.click(sheet().getByRole("button", { name: "Fermer" }));
    expect(actions.reverseAdjustmentAction).not.toHaveBeenCalled();
  });

  it("has an empty state, and recovers from a failed older page", async () => {
    await renderCard();
    actions.listClientLoyaltyLedgerAction
      .mockResolvedValueOnce(ok({ entries: [entry(1)], nextCursor: "9" }))
      .mockResolvedValueOnce(fail("internal"))
      .mockResolvedValueOnce(ok({ entries: [entry(2)], nextCursor: null }));
    fireEvent.click(
      card().getByRole("button", { name: "Historique des points" }),
    );
    await flush();
    fireEvent.click(
      sheet().getByRole("button", {
        name: "Afficher les opérations plus anciennes",
      }),
    );
    await flush();
    expect(
      sheet().getByText(/plus anciennes n’ont pas pu être chargées/),
    ).toBeTruthy();
    expect(sheet().getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(sheet().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(sheet().getAllByRole("listitem")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Operations whose answer was lost: kept per requestId, across reloads.
// ---------------------------------------------------------------------------

type Sent = { requestId: string } & Record<string, unknown>;
/** Applies each requestId once, with the payload it first came with. */
function idempotentServer(mock: typeof actions.adjustPointsAction) {
  const applied = new Map<string, Sent>();
  const behaviours: ("ok" | "lose")[] = [];
  mock.mockImplementation((command: Sent) => {
    if (!applied.has(command.requestId))
      applied.set(command.requestId, command);
    return behaviours.shift() === "lose"
      ? Promise.reject(new Error("answer lost"))
      : Promise.resolve(
          ok("rewardId" in command ? redemption() : { entryId: entry(9).id }),
        );
  });
  return {
    next: (...next: ("ok" | "lose")[]) => behaviours.push(...next),
    applied: () => [...applied.values()],
  };
}

async function adjustFromCard(
  direction: "Créditer" | "Débiter",
  amount: string,
  reason: string,
) {
  fireEvent.click(card().getByRole("button", { name: "Ajuster les points" }));
  fireEvent.click(sheet().getByLabelText(new RegExp(direction)));
  fireEvent.change(sheet().getByLabelText("Nombre de points"), {
    target: { value: amount },
  });
  fireEvent.change(sheet().getByLabelText(/^Motif/), {
    target: { value: reason },
  });
  fireEvent.click(sheet().getByRole("button", { name: "Vérifier" }));
  fireEvent.click(
    sheet().getByRole("button", { name: `${direction} ${amount} points` }),
  );
  await flush();
}

/** A full reload: fresh modules (no memory left), same browser storage. */
async function reloadCard(scope = SCOPE) {
  cleanupAll();
  vi.resetModules();
  const fresh = await import("./client-loyalty");
  actions.getClientLoyaltyAction.mockResolvedValue(ok(summary()));
  actions.listRewardsAction.mockResolvedValue(ok(rewards));
  actions.listClientRedemptionsAction.mockResolvedValue(ok([]));
  render(
    <fresh.ClientLoyalty
      scope={scope}
      timezone="Europe/Paris"
      visits={[]}
      onChanged={vi.fn()}
    />,
  );
  await flush();
}
const cleanupAll = () => cleanup();

describe("operations whose answer was lost", () => {
  it("debit applied, answer lost, full reload, unchanged resend: no second debit", async () => {
    const server = idempotentServer(actions.adjustPointsAction);
    await renderCard();
    server.next("lose");
    await adjustFromCard("Débiter", "20", "Correction manuelle");
    expect(sheet().getByText(/marquée non confirmée/)).toBeTruthy();
    const first = server.applied()[0]!.requestId;

    await reloadCard();
    expect(card().getByText("Opérations non confirmées")).toBeTruthy();
    expect(
      card().getByText(/Débit de 20 points : Correction manuelle/),
    ).toBeTruthy();
    // Typed again the same way after the reload: the same request, not a new one.
    server.next("ok");
    await adjustFromCard("Débiter", "20", "Correction manuelle");
    const ids = actions.adjustPointsAction.mock.calls.map(
      ([command]) => (command as Sent).requestId,
    );
    expect(ids).toEqual([first, first]);
    expect(server.applied()).toHaveLength(1);
    expect(card().queryByText("Opérations non confirmées")).toBeNull();
  });

  it("resends a pending operation explicitly, with its own requestId and payload", async () => {
    const server = idempotentServer(actions.redeemRewardAction);
    await renderCard();
    server.next("lose");
    fireEvent.click(
      card().getByRole("button", { name: /Attribuer une récompense/ }),
    );
    fireEvent.click(sheet().getByLabelText(/Remise 5 €/));
    fireEvent.click(sheet().getByRole("button", { name: "Continuer" }));
    fireEvent.click(sheet().getByRole("button", { name: /Attribuer \(/ }));
    await flush();
    const [lost] = server.applied();

    await reloadCard();
    expect(
      card().getByText(/Attribution : Remise 5 € \(−50 points\)/),
    ).toBeTruthy();
    server.next("ok");
    fireEvent.click(
      card().getByRole("button", { name: "Renvoyer la même demande" }),
    );
    await flush();
    const resent = lastCall(actions.redeemRewardAction);
    expect(resent).toEqual({
      clientId: CLIENT,
      rewardId: REWARD,
      requestId: lost!.requestId,
    });
    expect(redeemRewardSchema.safeParse(resent).success).toBe(true);
    expect(server.applied()).toHaveLength(1);
    expect(card().getByText(/Opération confirmée : Attribution/)).toBeTruthy();
    expect(card().queryByText("Opérations non confirmées")).toBeNull();
  });

  it("keeps several uncertain operations apart: resolving one leaves the other", async () => {
    const server = idempotentServer(actions.adjustPointsAction);
    await renderCard();
    server.next("lose", "lose");
    await adjustFromCard("Créditer", "30", "Geste A");
    fireEvent.click(sheet().getByRole("button", { name: "Fermer" }));
    await adjustFromCard("Débiter", "10", "Retrait B");
    fireEvent.click(sheet().getByRole("button", { name: "Fermer" }));
    const [a, b] = server.applied();
    expect(a!.requestId).not.toBe(b!.requestId);

    await reloadCard();
    const items = card().getAllByRole("button", {
      name: "Renvoyer la même demande",
    });
    expect(items).toHaveLength(2);
    server.next("ok");
    // The second one (B).
    fireEvent.click(items[1]!);
    await flush();
    expect(lastCall(actions.adjustPointsAction).requestId).toBe(b!.requestId);
    expect(card().getByText(/Crédit de 30 points : Geste A/)).toBeTruthy();
    // Only A is still pending.
    expect(
      card().getAllByRole("button", { name: "Renvoyer la même demande" }),
    ).toHaveLength(1);
    expect(
      card().getByText(/Opération confirmée : Débit de 10 points/),
    ).toBeTruthy();
    expect(server.applied()).toHaveLength(2);
  });

  it("forgets an operation once refused for good (nothing was written)", async () => {
    actions.adjustPointsAction.mockResolvedValue(fail("insufficient_points"));
    await renderCard();
    await adjustFromCard("Débiter", "10", "Retrait");
    await reloadCard();
    expect(card().queryByText("Opérations non confirmées")).toBeNull();
  });

  it("dismissing one is explicit and explained", async () => {
    const server = idempotentServer(actions.adjustPointsAction);
    await renderCard();
    server.next("lose");
    await adjustFromCard("Créditer", "30", "Geste");
    fireEvent.click(sheet().getByRole("button", { name: "Fermer" }));
    fireEvent.click(card().getByRole("button", { name: "Ne plus la suivre" }));
    expect(
      sheet().getByText(/Si elle figure dans l’historique des\s+points/),
    ).toBeTruthy();
    fireEvent.click(sheet().getByRole("button", { name: "Ne plus la suivre" }));
    expect(card().queryByText("Opérations non confirmées")).toBeNull();
  });

  it("is isolated per user, business and customer", async () => {
    const server = idempotentServer(actions.adjustPointsAction);
    await renderCard();
    server.next("lose");
    await adjustFromCard("Créditer", "30", "Geste");
    for (const other of [
      { ...SCOPE, userId: "10000000-0000-4000-8000-0000000000cc" },
      { ...SCOPE, businessId: "10000000-0000-4000-8000-0000000000dd" },
      { ...SCOPE, clientId: "20000000-0000-4000-8000-000000000099" },
    ]) {
      await reloadCard(other);
      expect(card().queryByText("Opérations non confirmées")).toBeNull();
    }
    await reloadCard(SCOPE);
    expect(card().getByText("Opérations non confirmées")).toBeTruthy();
  });

  it("shows an operation left uncertain in another tab", async () => {
    await renderCard();
    const key = `loyalty-pending:${SCOPE.userId}:${SCOPE.businessId}:${CLIENT}`;
    const operation = {
      requestId: "50000000-0000-4000-8000-000000000001",
      kind: "credit",
      command: { clientId: CLIENT, pointsDelta: 15, reason: "Autre onglet" },
      fingerprint: "x",
      createdAt: "2026-10-20T08:00:00Z",
    };
    act(() => {
      window.localStorage.setItem(key, JSON.stringify([operation]));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(card().getByText(/Crédit de 15 points : Autre onglet/)).toBeTruthy();
  });
});

describe("cancelling a manual adjustment", () => {
  const cases: [string, number, number, boolean][] = [
    // [what, balance, adjustment, may be cancelled]
    ["a debit, negative balance (−100 → −90)", -100, -10, true],
    ["a debit, zero balance", 0, -10, true],
    ["a debit, positive balance", 50, -10, true],
    ["a credit, enough balance", 50, 20, true],
    ["a credit, exactly the balance (→ 0)", 20, 20, true],
    ["a credit already partly spent", 10, 20, false],
    ["a credit, zero balance", 0, 20, false],
    ["a credit, negative balance", -100, 20, false],
  ];
  it.each(cases)("%s", async (_, balance, delta, allowed) => {
    await renderCard({ loyalty: summary({ balance }) });
    actions.listClientLoyaltyLedgerAction.mockResolvedValue(
      ok({
        entries: [
          entry(1, {
            type: "manual_adjustment",
            pointsDelta: delta,
            reason: "Ajustement",
          }),
        ],
        nextCursor: null,
      }),
    );
    fireEvent.click(
      card().getByRole("button", { name: "Historique des points" }),
    );
    await flush();
    fireEvent.click(
      sheet().getByRole("button", { name: "Annuler cet ajustement" }),
    );
    if (allowed) {
      expect(
        sheet().getByText(
          new RegExp(
            `passe de\\s+${points(balance)} à ${points(balance - delta)}`,
          ),
        ),
      ).toBeTruthy();
      actions.reverseAdjustmentAction.mockResolvedValue(
        ok({ entryId: entry(2).id }),
      );
      fireEvent.click(
        sheet().getByRole("button", { name: "Annuler l’ajustement" }),
      );
      await flush();
      expect(actions.reverseAdjustmentAction).toHaveBeenCalledTimes(1);
    } else {
      expect(sheet().getByText("Solde insuffisant")).toBeTruthy();
      fireEvent.click(sheet().getByRole("button", { name: "Compris" }));
      expect(actions.reverseAdjustmentAction).not.toHaveBeenCalled();
    }
  });

  it("leaves the backend in charge: its refusal is shown, nothing is claimed", async () => {
    await renderCard({ loyalty: summary({ balance: -100 }) });
    actions.listClientLoyaltyLedgerAction.mockResolvedValue(
      ok({
        entries: [
          entry(1, {
            type: "manual_adjustment",
            pointsDelta: -10,
            reason: "Retrait",
          }),
        ],
        nextCursor: null,
      }),
    );
    fireEvent.click(
      card().getByRole("button", { name: "Historique des points" }),
    );
    await flush();
    fireEvent.click(
      sheet().getByRole("button", { name: "Annuler cet ajustement" }),
    );
    actions.reverseAdjustmentAction.mockResolvedValue(
      fail("insufficient_points"),
    );
    fireEvent.click(
      sheet().getByRole("button", { name: "Annuler l’ajustement" }),
    );
    await flush();
    expect(sheet().getByText("Solde insuffisant")).toBeTruthy();
    expect(sheet().getByText(/Rien n’a été changé/)).toBeTruthy();
  });
});
