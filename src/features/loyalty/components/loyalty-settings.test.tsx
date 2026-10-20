// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureProgramSchema,
  createRewardSchema,
  setServiceRuleSchema,
  updateRewardSchema,
} from "../schemas/loyalty";
import type { LoyaltyProgramDto, RewardDto } from "../types";
import { LoyaltySettings } from "./loyalty-settings";

// The loyalty settings screen, from what the professional sees and does.
// The Server Actions are mocked at their module boundary with their real
// result shapes; every command sent is checked against the real zod
// schema of that action.

const { actions } = vi.hoisted(() => ({
  actions: {
    getLoyaltyProgramAction: vi.fn(),
    configureLoyaltyProgramAction: vi.fn(),
    setLoyaltyServiceRuleAction: vi.fn(),
    listRewardsAction: vi.fn(),
    createRewardAction: vi.fn(),
    updateRewardAction: vi.fn(),
    listServicesAction: vi.fn(),
    getBookingSettingsAction: vi.fn(),
  },
}));
vi.mock("@/features/loyalty/actions/loyalty", () => ({
  getLoyaltyProgramAction: (...args: unknown[]) =>
    actions.getLoyaltyProgramAction(...args),
  configureLoyaltyProgramAction: (...args: unknown[]) =>
    actions.configureLoyaltyProgramAction(...args),
  setLoyaltyServiceRuleAction: (...args: unknown[]) =>
    actions.setLoyaltyServiceRuleAction(...args),
  listRewardsAction: (...args: unknown[]) => actions.listRewardsAction(...args),
  createRewardAction: (...args: unknown[]) =>
    actions.createRewardAction(...args),
  updateRewardAction: (...args: unknown[]) =>
    actions.updateRewardAction(...args),
}));
vi.mock("@/features/services/actions/services", () => ({
  listServicesAction: (...args: unknown[]) =>
    actions.listServicesAction(...args),
}));
vi.mock("@/features/availability/actions/schedule", () => ({
  getBookingSettingsAction: (...args: unknown[]) =>
    actions.getBookingSettingsAction(...args),
}));

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

const SERVICE_ID = "30000000-0000-4000-8000-000000000001";
const program = (
  overrides: Partial<LoyaltyProgramDto> = {},
): LoyaltyProgramDto => ({
  active: false,
  accrualMode: "appointment",
  pointsPerCompletedAppointment: 1,
  pointsPerEuro: null,
  version: 0,
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
const services = [
  {
    id: SERVICE_ID,
    name: "Rehaussement de cils",
    description: null,
    durationMinutes: 75,
    priceCents: 6500,
    active: true,
    displayOrder: 1,
    version: 1,
  },
];

async function renderScreen({
  loyalty = program(),
  rewards = [] as RewardDto[],
} = {}) {
  actions.getLoyaltyProgramAction.mockResolvedValue(ok(loyalty));
  actions.listRewardsAction.mockResolvedValue(ok(rewards));
  actions.listServicesAction.mockResolvedValue(ok(services));
  actions.getBookingSettingsAction.mockResolvedValue(ok({ currency: "EUR" }));
  const view = render(<LoyaltySettings />);
  await flush();
  return view;
}

const dialog = () => within(screen.getByRole("dialog"));
const section = (name: RegExp) => within(screen.getByRole("region", { name }));
const lastCall = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("loading", () => {
  it("shows a loading state, then an error with a retry, never fake data", async () => {
    actions.getLoyaltyProgramAction.mockResolvedValueOnce(fail("internal"));
    actions.listRewardsAction.mockResolvedValue(ok([]));
    actions.listServicesAction.mockResolvedValue(ok(services));
    actions.getBookingSettingsAction.mockResolvedValue(ok({ currency: "EUR" }));
    render(<LoyaltySettings />);
    expect(screen.getByRole("status").textContent).toMatch(/Chargement/);
    await flush();
    expect(
      screen.getByText(/La fidélité n’a pas pu être chargée/),
    ).toBeTruthy();

    actions.getLoyaltyProgramAction.mockResolvedValue(ok(program()));
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Programme" })).toBeTruthy();
  });

  it("offers to sign in again when the session expired", async () => {
    actions.getLoyaltyProgramAction.mockResolvedValue(fail("unauthenticated"));
    actions.listRewardsAction.mockResolvedValue(ok([]));
    actions.listServicesAction.mockResolvedValue(ok([]));
    actions.getBookingSettingsAction.mockResolvedValue(ok({ currency: "EUR" }));
    render(<LoyaltySettings />);
    await flush();
    expect(
      screen.getByRole("link", { name: "Me reconnecter" }).getAttribute("href"),
    ).toBe("/login");
  });
});

describe("program", () => {
  it("explains a business with no program yet, and activates it after an explicit confirmation", async () => {
    await renderScreen();
    expect(screen.getByText(/Aucun programme configuré/)).toBeTruthy();
    expect(screen.getByText("Inactif")).toBeTruthy();
    expect(screen.getByText(/jamais au moment de la réservation/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Activer le programme" }),
    );
    expect(
      dialog().getByText(/ne rapportent rien\s+rétroactivement/),
    ).toBeTruthy();
    expect(actions.configureLoyaltyProgramAction).not.toHaveBeenCalled();

    const answer = deferred<unknown>();
    actions.configureLoyaltyProgramAction.mockReturnValue(answer.promise);
    fireEvent.click(dialog().getByRole("button", { name: "Activer" }));
    fireEvent.click(dialog().getByRole("button", { name: /Activer/ }));
    expect(actions.configureLoyaltyProgramAction).toHaveBeenCalledTimes(1);
    const command = lastCall(actions.configureLoyaltyProgramAction);
    expect(command).toMatchObject({ expectedVersion: 0, active: true });
    expect(configureProgramSchema.safeParse(command).success).toBe(true);
    // Nothing is shown as active before the answer.
    expect(screen.queryByText("Actif")).toBeNull();

    answer.resolve(ok(program({ active: true, version: 1 })));
    await flush();
    expect(screen.getByText("Actif")).toBeTruthy();
    expect(screen.getByText("Programme activé.")).toBeTruthy();
  });

  it("saves the spend mode with the rate as an exact decimal string", async () => {
    await renderScreen({ loyalty: program({ active: true, version: 4 }) });
    fireEvent.click(screen.getByLabelText(/Au montant/));
    fireEvent.change(screen.getByLabelText("Points par euro"), {
      target: { value: "1,5" },
    });
    // Activation waits for the draft to be saved or cancelled.
    expect(
      (
        screen.getByRole("button", {
          name: "Mettre en pause",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    actions.configureLoyaltyProgramAction.mockResolvedValue(
      ok(
        program({
          active: true,
          version: 5,
          accrualMode: "spend",
          pointsPerEuro: "1.5",
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await flush();
    const command = lastCall(actions.configureLoyaltyProgramAction);
    expect(command).toEqual({
      expectedVersion: 4,
      active: true,
      accrualMode: "spend",
      pointsPerCompletedAppointment: 1,
      pointsPerEuro: "1.5",
    });
    expect(configureProgramSchema.safeParse(command).success).toBe(true);
    expect(screen.getByText("Réglages enregistrés.")).toBeTruthy();
    expect(screen.getAllByText(/1,5 point par euro/).length).toBeGreaterThan(0);
  });

  it("checks values before sending and maps backend field errors to the fields", async () => {
    await renderScreen({ loyalty: program({ version: 2 }) });
    fireEvent.change(screen.getByLabelText("Points par rendez-vous terminé"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(actions.configureLoyaltyProgramAction).not.toHaveBeenCalled();
    expect(screen.getByText(/nombre entier de 1 à 10/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Points par rendez-vous terminé"), {
      target: { value: "20" },
    });
    actions.configureLoyaltyProgramAction.mockResolvedValue(
      fail("validation_error", {
        pointsPerCompletedAppointment: ["Trop grand."],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await flush();
    expect(screen.getByText("Trop grand.")).toBeTruthy();
    expect(screen.queryByText("Réglages enregistrés.")).toBeNull();
    expect(screen.getByText(/Rien n’a été enregistré/)).toBeTruthy();
  });

  it("on a version conflict, shows the current program and lets her choose", async () => {
    await renderScreen({ loyalty: program({ active: true, version: 2 }) });
    fireEvent.change(screen.getByLabelText("Points par rendez-vous terminé"), {
      target: { value: "15" },
    });
    actions.configureLoyaltyProgramAction.mockResolvedValueOnce(
      fail("stale_loyalty_program"),
    );
    actions.getLoyaltyProgramAction.mockResolvedValue(
      ok(
        program({
          active: false,
          version: 3,
          pointsPerCompletedAppointment: 8,
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await flush();
    expect(screen.getByText("Programme modifié entre-temps")).toBeTruthy();
    expect(
      screen.getByText(/programme inactif, 8 points par rendez-vous/),
    ).toBeTruthy();

    // Keep mine: the draft stays, now based on version 3.
    fireEvent.click(
      screen.getByRole("button", { name: "Garder mes réglages" }),
    );
    expect(
      (
        screen.getByLabelText(
          "Points par rendez-vous terminé",
        ) as HTMLInputElement
      ).value,
    ).toBe("15");
    actions.configureLoyaltyProgramAction.mockResolvedValue(
      ok(
        program({
          active: false,
          version: 4,
          pointsPerCompletedAppointment: 15,
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await flush();
    expect(lastCall(actions.configureLoyaltyProgramAction)).toMatchObject({
      expectedVersion: 3,
      active: false,
      pointsPerCompletedAppointment: 15,
    });
  });

  it("takes the current version when she prefers it", async () => {
    await renderScreen({ loyalty: program({ version: 2 }) });
    fireEvent.change(screen.getByLabelText("Points par rendez-vous terminé"), {
      target: { value: "15" },
    });
    actions.configureLoyaltyProgramAction.mockResolvedValue(
      fail("stale_loyalty_program"),
    );
    actions.getLoyaltyProgramAction.mockResolvedValue(
      ok(program({ version: 3, pointsPerCompletedAppointment: 8 })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre la version actuelle" }),
    );
    expect(
      (
        screen.getByLabelText(
          "Points par rendez-vous terminé",
        ) as HTMLInputElement
      ).value,
    ).toBe("8");
  });

  it("says a lost answer may have been saved, and retries without doubling", async () => {
    await renderScreen({ loyalty: program({ version: 2 }) });
    fireEvent.change(screen.getByLabelText("Points par rendez-vous terminé"), {
      target: { value: "15" },
    });
    actions.configureLoyaltyProgramAction.mockRejectedValueOnce(
      new Error("offline"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await flush();
    expect(screen.getByText("Connexion interrompue")).toBeTruthy();
    expect(screen.getByText(/a peut-être été enregistrée/)).toBeTruthy();
    expect(screen.queryByText("Réglages enregistrés.")).toBeNull();
  });
});

describe("service rules", () => {
  it("shows the program's calculation per service and saves a rule", async () => {
    await renderScreen({
      loyalty: program({
        active: true,
        accrualMode: "spend",
        pointsPerEuro: "0.5",
        version: 2,
      }),
    });
    const rules = section(/Règles par prestation/);
    expect(rules.getByText(/32 points au prix actuel/)).toBeTruthy();

    fireEvent.click(
      rules.getByRole("button", {
        name: /Définir une règle pour Rehaussement/,
      }),
    );
    fireEvent.change(dialog().getByLabelText(/Points pour un rendez-vous/), {
      target: { value: "0" },
    });
    actions.setLoyaltyServiceRuleAction.mockResolvedValue(
      ok(
        program({
          version: 2,
          serviceRules: [{ serviceId: SERVICE_ID, points: 0 }],
        }),
      ),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await flush();
    const command = lastCall(actions.setLoyaltyServiceRuleAction);
    expect(command).toEqual({ serviceId: SERVICE_ID, points: 0 });
    expect(setServiceRuleSchema.safeParse(command).success).toBe(true);
    expect(rules.getByText("Règle : aucun point")).toBeTruthy();
    // The rest of the program stays as confirmed on this screen.
    expect(screen.getByText("Actif")).toBeTruthy();
  });
});

describe("rewards", () => {
  it("has a useful empty state", async () => {
    await renderScreen();
    expect(screen.getByText("Aucune récompense pour l’instant")).toBeTruthy();
  });

  it("creates a reward once per content: same requestId on retry, a new one when the content changes", async () => {
    await renderScreen({ loyalty: program({ active: true, version: 1 }) });
    fireEvent.click(
      screen.getByRole("button", { name: /Nouvelle récompense/ }),
    );
    fireEvent.change(dialog().getByLabelText(/^Nom/), {
      target: { value: "Remise" },
    });
    fireEvent.change(dialog().getByLabelText(/Coût en points/), {
      target: { value: "50" },
    });
    fireEvent.change(dialog().getByLabelText(/Montant de la remise/), {
      target: { value: "5" },
    });

    actions.createRewardAction.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(
      dialog().getByRole("button", { name: "Créer la récompense" }),
    );
    await flush();
    expect(dialog().getByText(/a peut-être été enregistrée/)).toBeTruthy();

    const created = reward({
      id: "40000000-0000-4000-8000-000000000009",
      name: "Remise",
      pointsRequired: 50,
    });
    actions.createRewardAction.mockResolvedValueOnce(ok(created));
    fireEvent.click(
      dialog().getByRole("button", { name: "Créer la récompense" }),
    );
    await flush();
    const [first, second] = actions.createRewardAction.mock.calls.map(
      ([command]) => command as { requestId: string },
    );
    expect(second!.requestId).toBe(first!.requestId);
    expect(createRewardSchema.safeParse(second).success).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Récompense « Remise » créée.")).toBeTruthy();

    // A different reward afterwards: a new key.
    fireEvent.click(
      screen.getByRole("button", { name: /Nouvelle récompense/ }),
    );
    fireEvent.change(dialog().getByLabelText(/^Nom/), {
      target: { value: "Autre" },
    });
    fireEvent.change(dialog().getByLabelText(/Coût en points/), {
      target: { value: "60" },
    });
    fireEvent.change(dialog().getByLabelText(/Montant de la remise/), {
      target: { value: "6" },
    });
    actions.createRewardAction.mockResolvedValueOnce(
      ok(reward({ id: "40000000-0000-4000-8000-000000000010", name: "Autre" })),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Créer la récompense" }),
    );
    await flush();
    const third = lastCall(actions.createRewardAction) as { requestId: string };
    expect(third.requestId).not.toBe(first!.requestId);
  });

  it("never regenerates the requestId on its own after idempotency_conflict", async () => {
    await renderScreen({ loyalty: program({ active: true, version: 1 }) });
    fireEvent.click(
      screen.getByRole("button", { name: /Nouvelle récompense/ }),
    );
    fireEvent.change(dialog().getByLabelText(/^Nom/), {
      target: { value: "Remise" },
    });
    fireEvent.change(dialog().getByLabelText(/Coût en points/), {
      target: { value: "50" },
    });
    fireEvent.change(dialog().getByLabelText(/Montant de la remise/), {
      target: { value: "5" },
    });
    actions.createRewardAction.mockResolvedValueOnce(
      fail("idempotency_conflict"),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Créer la récompense" }),
    );
    await flush();
    expect(actions.createRewardAction).toHaveBeenCalledTimes(1);
    expect(dialog().getByText("Demande déjà utilisée")).toBeTruthy();

    actions.createRewardAction.mockResolvedValueOnce(
      ok(reward({ name: "Remise" })),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Créer comme nouvelle récompense" }),
    );
    await flush();
    const [first, second] = actions.createRewardAction.mock.calls.map(
      ([command]) => command as { requestId: string },
    );
    expect(second!.requestId).not.toBe(first!.requestId);
  });

  it("edits a historical reward without touching its untouched raw text", async () => {
    const historical = reward({
      name: "  Remise d’antan ",
      description: "Conditions  historiques ",
      pointsRequired: 2_000_000,
    });
    await renderScreen({
      loyalty: program({ active: true, version: 1 }),
      rewards: [historical],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Modifier\s+Remise d’antan/ }),
    );
    fireEvent.change(dialog().getByLabelText(/Montant de la remise/), {
      target: { value: "6" },
    });
    actions.updateRewardAction.mockResolvedValue(
      ok({ ...historical, rewardValue: 600, version: 3 }),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await flush();
    const command = lastCall(actions.updateRewardAction);
    expect(command).toMatchObject({
      name: "  Remise d’antan ",
      description: "Conditions  historiques ",
      pointsRequired: 2_000_000,
      rewardValue: 600,
      expectedVersion: 2,
      rewardType: "fixed_discount",
      active: true,
    });
    expect(updateRewardSchema.safeParse(command).success).toBe(true);
  });

  it("on an edit conflict, shows the current reward; keeping her changes rebases them", async () => {
    await renderScreen({
      loyalty: program({ active: true, version: 1 }),
      rewards: [reward()],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Modifier Remise fidélité" }),
    );
    fireEvent.change(dialog().getByLabelText(/Coût en points/), {
      target: { value: "80" },
    });
    actions.updateRewardAction.mockResolvedValueOnce(fail("stale_reward"));
    actions.listRewardsAction.mockResolvedValue(
      ok([reward({ name: "Remise d’automne", version: 5 })]),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await flush();
    expect(dialog().getByText("Récompense modifiée entre-temps")).toBeTruthy();
    expect(dialog().getByText(/« Remise d’automne »/)).toBeTruthy();
    // Nothing is sent again on its own.
    expect(actions.updateRewardAction).toHaveBeenCalledTimes(1);

    fireEvent.click(
      dialog().getByRole("button", { name: "Garder mes modifications" }),
    );
    actions.updateRewardAction.mockResolvedValueOnce(
      ok(reward({ pointsRequired: 80, version: 6 })),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await flush();
    expect(lastCall(actions.updateRewardAction)).toMatchObject({
      expectedVersion: 5,
      pointsRequired: 80,
    });
  });

  it("on an edit conflict, can take the current reward instead", async () => {
    await renderScreen({
      loyalty: program({ active: true, version: 1 }),
      rewards: [reward()],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Modifier Remise fidélité" }),
    );
    fireEvent.change(dialog().getByLabelText(/Coût en points/), {
      target: { value: "80" },
    });
    actions.updateRewardAction.mockResolvedValueOnce(fail("stale_reward"));
    actions.listRewardsAction.mockResolvedValue(
      ok([reward({ pointsRequired: 120, version: 5 })]),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await flush();
    fireEvent.click(
      dialog().getByRole("button", { name: "Reprendre la version actuelle" }),
    );
    expect(
      (dialog().getByLabelText(/Coût en points/) as HTMLInputElement).value,
    ).toBe("120");
  });

  it("deactivates a reward and marks it inactive only once confirmed", async () => {
    await renderScreen({
      loyalty: program({ active: true, version: 1 }),
      rewards: [reward()],
    });
    const answer = deferred<unknown>();
    actions.updateRewardAction.mockReturnValue(answer.promise);
    const toggle = screen.getByRole("button", {
      name: "Désactiver Remise fidélité",
    });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(actions.updateRewardAction).toHaveBeenCalledTimes(1);
    expect(lastCall(actions.updateRewardAction)).toMatchObject({
      active: false,
      expectedVersion: 2,
    });
    expect(screen.getByText("Active")).toBeTruthy();

    answer.resolve(ok(reward({ active: false, version: 3 })));
    await flush();
    expect(screen.getByText("Désactivée")).toBeTruthy();
  });

  it("re-reads the list after a stale toggle and changes nothing", async () => {
    await renderScreen({
      loyalty: program({ active: true, version: 1 }),
      rewards: [reward()],
    });
    actions.updateRewardAction.mockResolvedValue(fail("stale_reward"));
    actions.listRewardsAction.mockResolvedValue(
      ok([reward({ name: "Remise renommée", version: 3 })]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Désactiver Remise fidélité" }),
    );
    await flush();
    expect(screen.getByText("Remise renommée")).toBeTruthy();
    expect(screen.getByText("Modifiée entre-temps")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("shows a free service whose service is gone as unavailable, and asks for one before a toggle", async () => {
    await renderScreen({
      loyalty: program({ active: true, version: 1 }),
      rewards: [
        reward({
          rewardType: "free_service",
          rewardValue: null,
          serviceId: null,
          currency: null,
        }),
      ],
    });
    expect(
      screen.getByText(/la prestation offerte n’existe plus/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Désactiver Remise fidélité" }),
    );
    expect(actions.updateRewardAction).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Choisir la prestation" }),
    );
    expect(dialog().getByLabelText("Prestation offerte")).toBeTruthy();
  });

  it("does not claim a discount is applied automatically", async () => {
    await renderScreen({ loyalty: program({ active: true, version: 1 }) });
    fireEvent.click(
      screen.getByRole("button", { name: /Nouvelle récompense/ }),
    );
    expect(
      dialog().getByText(/rien n’est déduit automatiquement/),
    ).toBeTruthy();
  });
});
