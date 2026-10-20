// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientTimelineEvent } from "@/features/crm/types";

import {
  appointmentEvent,
  appointmentSummary,
  at,
  CLIENT_ID,
  emailEvent,
  loyaltyEvent,
  profile,
  timelinePage,
  uuid,
} from "../../../../tests/support/crm-fixtures";
import { ClientProfile } from "./client-profile";

// The signed-in identity, as the page passes it from the session.
const SCOPE = {
  userId: "10000000-0000-4000-8000-0000000000aa",
  businessId: "10000000-0000-4000-8000-0000000000bb",
};

const actions = {
  getClientProfileAction: vi.fn(),
  listClientTimelineAction: vi.fn(),
  listClientNotesAction: vi.fn(),
  createClientNoteAction: vi.fn(),
  updateClientNoteAction: vi.fn(),
  deleteClientNoteAction: vi.fn(),
  getClientRecordAction: vi.fn(),
  updateClientAction: vi.fn(),
  getClientLoyaltyAction: vi.fn(),
  listRewardsAction: vi.fn(),
  listClientRedemptionsAction: vi.fn(),
  adjustPointsAction: vi.fn(),
};
vi.mock("@/features/crm/actions/crm", () => ({
  listClientsAction: vi.fn(),
  getClientProfileAction: (...args: unknown[]) =>
    actions.getClientProfileAction(...args),
  listClientTimelineAction: (...args: unknown[]) =>
    actions.listClientTimelineAction(...args),
}));
vi.mock("@/features/crm/actions/client-notes", () => ({
  listClientNotesAction: (...args: unknown[]) =>
    actions.listClientNotesAction(...args),
  createClientNoteAction: (...args: unknown[]) =>
    actions.createClientNoteAction(...args),
  updateClientNoteAction: (...args: unknown[]) =>
    actions.updateClientNoteAction(...args),
  deleteClientNoteAction: (...args: unknown[]) =>
    actions.deleteClientNoteAction(...args),
}));
vi.mock("@/features/crm/actions/client-management", () => ({
  createClientAction: vi.fn(),
  getClientRecordAction: (...args: unknown[]) =>
    actions.getClientRecordAction(...args),
  updateClientAction: (...args: unknown[]) =>
    actions.updateClientAction(...args),
}));
vi.mock("@/features/loyalty/actions/loyalty", () => ({
  getClientLoyaltyAction: (...args: unknown[]) =>
    actions.getClientLoyaltyAction(...args),
  listRewardsAction: (...args: unknown[]) => actions.listRewardsAction(...args),
  listClientRedemptionsAction: (...args: unknown[]) =>
    actions.listClientRedemptionsAction(...args),
  adjustPointsAction: (...args: unknown[]) =>
    actions.adjustPointsAction(...args),
  listClientLoyaltyLedgerAction: vi.fn(),
  redeemRewardAction: vi.fn(),
  fulfilRedemptionAction: vi.fn(),
  cancelRedemptionAction: vi.fn(),
  reverseAdjustmentAction: vi.fn(),
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

const originalMatchMedia = window.matchMedia;
function useViewport(wide: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches:
        query.includes("reduced-motion") ||
        (wide && query.includes("min-width: 1024px")),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

async function renderProfile(
  data = profile(),
  events: ClientTimelineEvent[] = [appointmentEvent()],
  nextCursor: string | null = null,
) {
  actions.getClientProfileAction.mockResolvedValue(ok(data));
  actions.listClientTimelineAction.mockResolvedValueOnce(
    ok(timelinePage(events, nextCursor)),
  );
  const view = render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
  await flush();
  return view;
}

const history = () =>
  within(screen.getByRole("region", { name: "Historique" }));
const lastTimelineInput = () =>
  actions.listClientTimelineAction.mock.calls[
    actions.listClientTimelineAction.mock.calls.length - 1
  ]![0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.listClientNotesAction.mockResolvedValue(
    ok({
      timezone: "Europe/Paris",
      legacyNotes: null,
      notes: [],
      nextCursor: null,
    }),
  );
  actions.getClientLoyaltyAction.mockResolvedValue(
    ok({
      clientId: CLIENT_ID,
      programActive: true,
      balance: 40,
      pointsCredited: 40,
      pointsDebited: 0,
      issuedRedemptions: 0,
      rewards: [],
    }),
  );
  actions.listRewardsAction.mockResolvedValue(ok([]));
  actions.listClientRedemptionsAction.mockResolvedValue(ok([]));
  window.sessionStorage.clear();
  window.localStorage.clear();
  useViewport(true);
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

describe("relationship overview", () => {
  it("loads profile and history in parallel, from the session's business", async () => {
    await renderProfile();
    expect(actions.getClientProfileAction).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
    });
    expect(actions.listClientTimelineAction).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      limit: 20,
    });
  });

  it("who she is, since her first visit, and four facts", async () => {
    await renderProfile();
    expect(
      screen.getByRole("heading", { level: 1, name: "Emma Laurent" }),
    ).toBeTruthy();
    expect(screen.getByText("Première visite en mars 2025")).toBeTruthy();
    const facts = screen.getAllByRole("term").map((term) => term.textContent);
    expect(facts.slice(0, 4)).toEqual([
      "Visites terminées",
      "Dernière visite",
      "Prestation favorite",
      "À venir",
    ]);
    expect(screen.getByText("7 fois")).toBeTruthy();
  });

  it("never visited: the record's creation date, never presented as the start of the relationship", async () => {
    await renderProfile(
      profile({
        overview: {
          completedCount: 0,
          firstCompletedVisitAt: null,
          lastCompletedVisitAt: null,
          favoriteService: null,
          completedServiceValue: [],
          cancelledCount: 0,
          noShowCount: 0,
        },
      }),
      [],
    );
    // In the header (no visit yet) and, as always, in the dossier.
    expect(screen.getAllByText("Fiche créée le 14 mars 2025")).toHaveLength(2);
    expect(screen.queryByText(/Première visite/)).toBeNull();
    expect(screen.queryByText(/Valeur des prestations/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/0,00 €|0 €/);
    expect(
      history().getByText(
        "Pas encore d’historique. Ses rendez-vous passés et tes notes apparaîtront ici.",
      ),
    ).toBeTruthy();
  });

  it("the next appointment is pinned, and the agenda link says it opens the day", async () => {
    await renderProfile();
    const next = within(
      screen.getByRole("region", { name: "Prochain rendez-vous" }),
    );
    expect(next.getByText("Prochain rendez-vous · 14:30 – 15:45")).toBeTruthy();
    expect(
      next.getByText(/Rehaussement de cils · 65,00\s€ prévus/),
    ).toBeTruthy();
    expect(next.getByText("et 1 autre à venir")).toBeTruthy();
    const link = next.getByRole("link", {
      name: "Voir la journée dans l’agenda",
    });
    expect(link.getAttribute("href")).toBe("/app?date=2026-10-24");
  });

  it("past appointments without a status: a gentle reminder towards the agenda", async () => {
    await renderProfile(profile({ overview: { pastConfirmedCount: 2 } }));
    expect(
      screen.getByText(/2 rendez-vous passés attendent leur statut/),
    ).toBeTruthy();
  });

  it("phones: one compact line instead of the four facts, then Historique | Dossier", async () => {
    useViewport(false);
    await renderProfile();
    expect(
      screen.getByText(
        "12 visites · dernière le 2 oct. · favorite : Remplissage cil à cil",
      ),
    ).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Historique",
      "Dossier",
    ]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("region", { name: "Historique" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Coordonnées" })).toBeNull();

    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[1]!.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getAllByRole("tab")[1]);
    expect(screen.getByRole("region", { name: "Coordonnées" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Historique" })).toBeNull();
  });

  it("the history is in the page once, whatever the width", async () => {
    await renderProfile();
    expect(screen.getAllByRole("region", { name: "Historique" })).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("region", { name: "Coordonnées" })).toHaveLength(
      1,
    );
  });
});

describe("dossier", () => {
  it("contact details with copy, or 'Non renseigné'", async () => {
    await renderProfile(profile({ client: { phone: null } }));
    const contact = within(screen.getByRole("region", { name: "Coordonnées" }));
    expect(contact.getByText("emma.laurent@exemple.fr")).toBeTruthy();
    expect(contact.getByText("Non renseigné")).toBeTruthy();
    // One copy button (no phone to copy), next to "Modifier la fiche".
    expect(contact.getAllByRole("button", { name: /^Copier/ })).toHaveLength(1);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(contact.getByRole("button", { name: "Copier l’email" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("emma.laurent@exemple.fr");
    expect(contact.getByText("Copié")).toBeTruthy();
  });

  it("completed service value: per currency, never summed, never called revenue", async () => {
    await renderProfile(
      profile({
        overview: {
          completedServiceValue: [
            { amountCents: 71200, currency: "EUR", appointmentCount: 12 },
            { amountCents: 9000, currency: "CHF", appointmentCount: 1 },
          ],
        },
      }),
    );
    const value = within(
      screen.getByRole("region", { name: "Valeur des prestations réalisées" }),
    );
    expect(value.getByText(/712,00\s€/)).toBeTruthy();
    expect(value.getByText(/90,00\sCHF/)).toBeTruthy();
    expect(value.getByText("12 rendez-vous terminés")).toBeTruthy();
    expect(value.getByText(/Ce n’est pas un encaissement/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /chiffre d’affaires|encaissé|payé|revenu|802/i,
    );
    // Not among the four headline facts.
    expect(
      screen
        .getAllByRole("term")
        .slice(0, 4)
        .map((t) => t.textContent),
    ).not.toContain("Valeur des prestations réalisées");
  });

  it("observed habits only show what exists; upcoming appointments link to their day", async () => {
    await renderProfile(
      profile({ overview: { cancelledCount: 0, noShowCount: 3 } }),
    );
    const habits = within(
      screen.getByRole("region", { name: "Habitudes observées" }),
    );
    expect(habits.queryByText("Annulations")).toBeNull();
    expect(habits.getByText("Absences")).toBeTruthy();
    const upcoming = within(screen.getByRole("region", { name: "À venir" }));
    expect(
      upcoming
        .getAllByRole("link", { name: "Voir la journée dans l’agenda" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/app?date=2026-10-24", "/app?date=2026-11-21"]);
  });

  it("only actions that work: editing and notes, nothing announced for later", async () => {
    await renderProfile();
    expect(
      screen.getByRole("button", { name: "Modifier la fiche" }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /^Ajouter une note/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /Préférences|Nouvelle cliente/ }),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(/Bientôt|Préférences/);
  });
});

describe("loyalty", () => {
  it("is part of the dossier, and a confirmed adjustment re-reads the history", async () => {
    await renderProfile();
    const loyalty = within(screen.getByRole("region", { name: "Fidélité" }));
    expect(loyalty.getByText("40 points")).toBeTruthy();
    expect(actions.getClientLoyaltyAction).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
    });
    const timelineReads = actions.listClientTimelineAction.mock.calls.length;

    fireEvent.click(
      loyalty.getByRole("button", { name: "Ajuster les points" }),
    );
    const sheet = within(screen.getByRole("dialog"));
    fireEvent.change(sheet.getByLabelText("Nombre de points"), {
      target: { value: "5" },
    });
    fireEvent.change(sheet.getByLabelText(/^Motif/), {
      target: { value: "Geste" },
    });
    fireEvent.click(sheet.getByRole("button", { name: "Vérifier" }));
    actions.adjustPointsAction.mockResolvedValue(ok({ entryId: uuid() }));
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([appointmentEvent()], null)),
    );
    fireEvent.click(sheet.getByRole("button", { name: "Créditer 5 points" }));
    await flush();
    expect(actions.listClientTimelineAction.mock.calls.length).toBe(
      timelineReads + 1,
    );
    expect(loyalty.getByText("5 points crédités.")).toBeTruthy();
  });
});

// A stand-in for the backend's idempotency, from the actions' side: every
// requestId sent is applied once with the payload it first came with; the
// same requestId again applies nothing more (docs/LOYALTY_CONTRACT.md).
type Adjust = { requestId: string; pointsDelta: number; reason: string };
function idempotentServer() {
  const applied = new Map<string, Adjust>();
  const behaviours: ("ok" | "lose" | "hold")[] = [];
  const held: (() => void)[] = [];
  actions.adjustPointsAction.mockImplementation((command: Adjust) => {
    if (!applied.has(command.requestId))
      applied.set(command.requestId, command);
    const behaviour = behaviours.shift() ?? "ok";
    const answer = ok({ entryId: uuid() });
    if (behaviour === "lose") return Promise.reject(new Error("answer lost"));
    if (behaviour === "hold")
      return new Promise((resolve) => held.push(() => resolve(answer)));
    return Promise.resolve(answer);
  });
  return {
    next: (...next: ("ok" | "lose" | "hold")[]) => behaviours.push(...next),
    release: () => held.shift()?.(),
    /** How many times this content was applied (distinct requestIds). */
    applications: (reason: string) =>
      [...applied.values()].filter((command) => command.reason === reason)
        .length,
  };
}

/** matchMedia whose answer changes like a real window resize. */
function resizableViewport(initiallyWide: boolean) {
  let wide = initiallyWide;
  const listeners = new Set<() => void>();
  window.matchMedia = (query: string) =>
    ({
      get matches() {
        return (
          query.includes("reduced-motion") ||
          (wide && query.includes("min-width: 1024px"))
        );
      },
      media: query,
      addEventListener: (_: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        listeners.delete(listener),
    }) as unknown as MediaQueryList;
  return (next: boolean) =>
    act(() => {
      wide = next;
      listeners.forEach((listener) => listener());
    });
}

const loyaltyCard = () =>
  within(screen.getByRole("region", { name: "Fidélité" }));
async function creditFromCard(points: string, reason: string) {
  fireEvent.click(
    loyaltyCard().getByRole("button", { name: "Ajuster les points" }),
  );
  const sheet = within(screen.getAllByRole("dialog").at(-1)!);
  fireEvent.change(sheet.getByLabelText("Nombre de points"), {
    target: { value: points },
  });
  fireEvent.change(sheet.getByLabelText(/^Motif/), {
    target: { value: reason },
  });
  fireEvent.click(sheet.getByRole("button", { name: "Vérifier" }));
  fireEvent.click(
    sheet.getByRole("button", { name: `Créditer ${points} points` }),
  );
  await flush();
}
const sentIds = () =>
  actions.adjustPointsAction.mock.calls.map(
    ([command]) => (command as Adjust).requestId,
  );

describe("concurrent loyalty operations (real profile, no artificial remount)", () => {
  it("A pending, desktop → phone, B lost, A answers late: B's retry is applied once", async () => {
    const resize = resizableViewport(true);
    const server = idempotentServer();
    await renderProfile();

    // A, on desktop: sent, its answer still pending.
    server.next("hold");
    await creditFromCard("5", "Opération A");
    // Desktop → phone: the dossier (and the loyalty card) is unmounted.
    await resize(false);
    fireEvent.click(screen.getByRole("tab", { name: "Dossier" }));
    await flush();

    // B, on the phone: applied by the server, its answer lost.
    server.next("lose");
    await creditFromCard("7", "Opération B");
    // A's late answer arrives.
    server.release();
    await flush();
    // A's answer settled A only: B's screen still shows B, unresolved.
    expect(
      within(screen.getAllByRole("dialog").at(-1)!).getByText(
        /marquée non confirmée/,
      ),
    ).toBeTruthy();
    expect(
      loyaltyCard().getByText(/Crédit de 7 points : Opération B/),
    ).toBeTruthy();
    expect(loyaltyCard().queryByText(/Opération A/)).toBeNull();

    // Retry of B, unchanged.
    fireEvent.click(
      within(screen.getAllByRole("dialog").at(-1)!).getByRole("button", {
        name: "Créditer 7 points",
      }),
    );
    await flush();
    const [a, b, retry] = sentIds();
    expect(retry).toBe(b);
    expect(b).not.toBe(a);
    expect(server.applications("Opération B")).toBe(1);
    expect(server.applications("Opération A")).toBe(1);
  });

  it("X uncertain, then Y, then X again: X keeps its identity", async () => {
    resizableViewport(true);
    const server = idempotentServer();
    await renderProfile();

    server.next("lose");
    await creditFromCard("5", "Opération X");
    fireEvent.click(
      within(screen.getAllByRole("dialog").at(-1)!).getByRole("button", {
        name: "Fermer",
      }),
    );
    server.next("ok");
    await creditFromCard("9", "Opération Y");
    // X again, typed again with the same content.
    server.next("ok");
    await creditFromCard("5", "Opération X");
    const [x, y, xAgain] = sentIds();
    expect(xAgain).toBe(x);
    expect(y).not.toBe(x);
    expect(server.applications("Opération X")).toBe(1);
  });
});

describe("loyalty keys", () => {
  it("phones: leaving the dossier tab after a lost answer keeps the same requestId", async () => {
    useViewport(false);
    await renderProfile();
    const tab = (name: string) => screen.getByRole("tab", { name });
    fireEvent.click(tab("Dossier"));
    await flush();
    const adjust = async () => {
      const loyalty = within(screen.getByRole("region", { name: "Fidélité" }));
      fireEvent.click(
        loyalty.getByRole("button", { name: "Ajuster les points" }),
      );
      const sheet = within(screen.getByRole("dialog"));
      fireEvent.change(sheet.getByLabelText("Nombre de points"), {
        target: { value: "5" },
      });
      fireEvent.change(sheet.getByLabelText(/^Motif/), {
        target: { value: "Geste" },
      });
      fireEvent.click(sheet.getByRole("button", { name: "Vérifier" }));
      fireEvent.click(sheet.getByRole("button", { name: "Créditer 5 points" }));
      await flush();
    };
    actions.adjustPointsAction.mockRejectedValueOnce(new Error("offline"));
    await adjust();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Modifier",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Annuler",
      }),
    );
    // The loyalty card is unmounted with the tab, then mounted again.
    fireEvent.click(tab("Historique"));
    fireEvent.click(tab("Dossier"));
    await flush();
    actions.adjustPointsAction.mockResolvedValue(ok({ entryId: uuid() }));
    await adjust();
    const [first, second] = actions.adjustPointsAction.mock.calls.map(
      ([command]) => (command as { requestId: string }).requestId,
    );
    expect(second).toBe(first);
  });
});

describe("timeline", () => {
  it("appointments: status written out, price only when meaningful, the contact of the time", async () => {
    await renderProfile(profile(), [
      appointmentEvent({
        start: "2026-10-02T14:30",
        end: "2026-10-02T15:30",
        completedAt: at("2026-10-02T15:42"),
      }),
      appointmentEvent({
        start: "2026-09-12T10:00",
        end: "2026-09-12T11:15",
        status: "cancelled",
        source: "manual",
        cancellationReason: "Empêchement de la cliente",
      }),
      appointmentEvent({
        start: "2026-09-03T09:30",
        end: "2026-09-03T11:30",
        status: "no_show",
        contact: {
          firstName: "Emma",
          lastName: "L.",
          email: "emma.l@exemple.fr",
          phone: null,
        },
      }),
      appointmentEvent({
        start: "2026-09-01T09:00",
        end: "2026-09-01T10:00",
        status: "confirmed",
      }),
    ]);
    const items = history().getAllByRole("article");
    expect(within(items[0]!).getByText("Terminé")).toBeTruthy();
    expect(
      within(items[0]!).getByText(
        /14:30 – 15:30 · 55,00\s€ · réservé en ligne/,
      ),
    ).toBeTruthy();
    expect(
      within(items[0]!).getByText("Marqué terminé le 2 octobre 2026 à 15:42"),
    ).toBeTruthy();

    // Cancelled: dated by its scheduled time, never "annulé le …".
    expect(within(items[1]!).getByText("Annulé")).toBeTruthy();
    expect(
      within(items[1]!).getByText("Prévu à 10:00 · ajouté par toi"),
    ).toBeTruthy();
    expect(
      within(items[1]!).getByText("« Empêchement de la cliente »"),
    ).toBeTruthy();
    expect(history().queryByText(/annulé le/i)).toBeNull();

    expect(within(items[2]!).getByText("Absente")).toBeTruthy();
    expect(within(items[2]!).queryByText(/€/)).toBeNull();
    expect(
      within(items[2]!).getByText(
        "Contact indiqué pour ce rendez-vous : Emma L. · emma.l@exemple.fr",
      ),
    ).toBeTruthy();

    expect(within(items[3]!).getByText("Statut à indiquer")).toBeTruthy();
    expect(
      within(items[3]!)
        .getByRole("link", { name: "Indiquer le statut dans l’agenda" })
        .getAttribute("href"),
    ).toBe("/app?date=2026-09-01");
  });

  it("loyalty and emails are lighter lines; a scheduled email is never 'sent'", async () => {
    await renderProfile(profile(), [
      loyaltyEvent({ local: "2026-10-02T15:43" }),
      loyaltyEvent({
        local: "2026-10-01T10:00",
        type: "reward_redeemed",
        pointsDelta: -100,
        reason: "Échange en institut",
        redemption: {
          id: uuid(),
          rewardId: uuid(),
          rewardName: "Soin des cils offert",
          pointsSpent: 100,
          redeemedAt: at("2026-10-01T10:00"),
        },
      }),
      emailEvent({ local: "2026-09-29T18:00" }),
      emailEvent({
        local: "2026-09-28T18:00",
        type: "appointment_reminder",
        status: "sent",
        sentAt: at("2026-09-28T18:01"),
      }),
    ]);
    expect(history().queryAllByRole("article")).toHaveLength(0);
    expect(history().getByText("+10 points")).toBeTruthy();
    expect(
      history().getByText(/Récompense échangée : Soin des cils offert/),
    ).toBeTruthy();
    expect(history().getByText("−100 points")).toBeTruthy();
    expect(
      history().getByText(
        "Programmé · pas encore envoyé · emma.laurent@exemple.fr",
      ),
    ).toBeTruthy();
    expect(
      history().getByText(
        "Envoyé le 28 septembre 2026 à 18:01 · emma.laurent@exemple.fr",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/reçu|délivré/i);
  });

  it("groups by business-local day, with a heading when the year changes", async () => {
    await renderProfile(profile(), [
      appointmentEvent({ start: "2026-01-02T10:00", end: "2026-01-02T11:00" }),
      appointmentEvent({ start: "2025-12-30T10:00", end: "2025-12-30T11:00" }),
    ]);
    expect(
      history()
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["2026", "2025"]);
    expect(
      history()
        .getAllByRole("time")
        .map((time) => time.getAttribute("datetime")),
    ).toEqual(["2026-01-02", "2025-12-30"]);
  });

  it("an event kind this screen does not know yet is skipped, not shown raw", async () => {
    const unknown = {
      id: "review:1",
      kind: "review",
      occurredAt: at("2026-10-03T10:00"),
    } as unknown as ClientTimelineEvent;
    await renderProfile(profile(), [unknown, appointmentEvent()]);
    expect(history().getAllByRole("article")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/review/);
  });

  it("older pages: appended without duplicates, focus on the first new event, announced", async () => {
    const first = appointmentEvent({ start: "2026-10-02T14:30" });
    const second = appointmentEvent({ start: "2026-09-02T14:30" });
    const third = appointmentEvent({ start: "2026-08-02T14:30" });
    await renderProfile(profile(), [first, second], "c1");

    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(timelinePage([second, third], null)),
    );
    fireEvent.click(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    );
    await flush();
    expect(lastTimelineInput()).toEqual({
      clientId: CLIENT_ID,
      limit: 20,
      cursor: "c1",
    });
    expect(history().getAllByRole("article")).toHaveLength(3);
    expect(document.activeElement?.getAttribute("data-event")).toBe(third.id);
    expect(history().getByText("1 événement plus ancien ajouté.")).toBeTruthy();
    expect(history().getByText("Début de l’historique.")).toBeTruthy();
  });

  it("a failed older page never removes what is shown", async () => {
    await renderProfile(profile(), [appointmentEvent()], "c1");
    actions.listClientTimelineAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    );
    await flush();
    expect(history().getAllByRole("article")).toHaveLength(1);
    expect(history().getByRole("alert").textContent).toMatch(
      /Ce qui est affiché reste valable/,
    );
  });

  it("a refused cursor restarts the history from the top", async () => {
    await renderProfile(profile(), [appointmentEvent()], "stale");
    actions.listClientTimelineAction.mockResolvedValueOnce(
      fail("validation_error", { cursor: ["invalid"] }),
    );
    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(timelinePage([appointmentEvent(), appointmentEvent()], null)),
    );
    fireEvent.click(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    );
    await flush();
    await flush();
    expect(lastTimelineInput()).toEqual({ clientId: CLIENT_ID, limit: 20 });
    expect(history().getAllByRole("article")).toHaveLength(2);
    expect(history().queryByRole("alert")).toBeNull();
  });
});

describe("errors", () => {
  it("profile fine, history failed: only the history zone reports it", async () => {
    actions.getClientProfileAction.mockResolvedValue(ok(profile()));
    actions.listClientTimelineAction.mockResolvedValueOnce(fail("internal"));
    render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
    await flush();
    expect(
      screen.getByRole("heading", { level: 1, name: "Emma Laurent" }),
    ).toBeTruthy();
    expect(history().getByRole("alert").textContent).toMatch(
      /L’historique n’a pas pu être chargé/,
    );
    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(timelinePage([appointmentEvent()])),
    );
    fireEvent.click(history().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(history().getAllByRole("article")).toHaveLength(1);
  });

  it("unknown or another business's customer: a clear dead end with a way back", async () => {
    actions.getClientProfileAction.mockResolvedValue(fail("client_not_found"));
    actions.listClientTimelineAction.mockResolvedValue(
      fail("client_not_found"),
    );
    window.sessionStorage.setItem("crm:directory", "/app/clients?q=Emma");
    render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
    await flush();
    expect(
      screen.getByRole("heading", { name: "Cette fiche n’existe pas ou plus" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Retour aux clientes" })
        .getAttribute("href"),
    ).toBe("/app/clients?q=Emma");
  });

  it("the profile fails: retry", async () => {
    actions.getClientProfileAction.mockResolvedValueOnce(fail("internal"));
    actions.listClientTimelineAction.mockResolvedValue(ok(timelinePage([])));
    render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(
      /La fiche n’a pas pu être chargée/,
    );
    actions.getClientProfileAction.mockResolvedValueOnce(ok(profile()));
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(
      screen.getByRole("heading", { level: 1, name: "Emma Laurent" }),
    ).toBeTruthy();
  });

  it("the back link returns to the list as it was", async () => {
    window.sessionStorage.setItem(
      "crm:directory",
      "/app/clients?filter=upcoming",
    );
    await renderProfile();
    expect(
      screen.getByRole("link", { name: "Clientes" }).getAttribute("href"),
    ).toBe("/app/clients?filter=upcoming");
  });
});

it("upcoming list says how many more there are beyond the five shown", async () => {
  const five = Array.from({ length: 5 }, (_, index) =>
    appointmentSummary({
      start: `2026-11-0${index + 1}T10:00`,
      end: `2026-11-0${index + 1}T11:00`,
    }),
  );
  await renderProfile(
    profile({ upcoming: five, overview: { upcomingCount: 8 } }),
  );
  expect(screen.getByText("et 3 autres plus tard")).toBeTruthy();
});

describe("time zones: every hour is labelled with the zone it was read in", () => {
  const PARIS = "Europe/Paris";
  const VANCOUVER = "America/Vancouver";
  const inZone = (page: ReturnType<typeof timelinePage>, timezone: string) => ({
    ...page,
    timezone,
  });
  const zoneLabel = () =>
    history().queryByText(/^Heures de /)?.textContent ?? null;

  it("profile read in Paris, history read in Vancouver: the history says Vancouver; the profile is re-read once", async () => {
    const vancouverProfile = { ...profile(), timezone: VANCOUVER };
    actions.getClientProfileAction
      .mockResolvedValueOnce(ok(profile())) // Paris
      .mockResolvedValueOnce(ok(vancouverProfile));
    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(inZone(timelinePage([appointmentEvent()]), VANCOUVER)),
    );
    render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
    await flush();
    await flush();

    expect(zoneLabel()).toBe(`Heures de ${VANCOUVER}`);
    expect(actions.getClientProfileAction).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(`Heures affichées dans le fuseau ${VANCOUVER}.`),
    ).toBeTruthy();
    expect(screen.queryByText(/Le fuseau horaire du commerce a changé/)).toBe(
      null,
    );
  });

  it("if the re-read profile still differs, both zones are named, and nothing is re-read again on its own", async () => {
    actions.getClientProfileAction.mockResolvedValue(ok(profile())); // Paris
    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(inZone(timelinePage([appointmentEvent()]), VANCOUVER)),
    );
    render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
    await flush();
    await flush();
    await flush();

    expect(zoneLabel()).toBe(`Heures de ${VANCOUVER}`);
    expect(
      screen.getByText(
        `Le fuseau horaire du commerce a changé : la fiche est en heures de ${PARIS}, l’historique en heures de ${VANCOUVER}.`,
      ),
    ).toBeTruthy();
    expect(actions.getClientProfileAction).toHaveBeenCalledTimes(2);
    expect(actions.listClientTimelineAction).toHaveBeenCalledTimes(1);
  });

  it("an older page in another zone is never appended: the history restarts from its first page", async () => {
    const paris = appointmentEvent({ start: "2026-10-02T14:30" });
    await renderProfile(profile(), [paris], "c1");
    expect(zoneLabel()).toBe(`Heures de ${PARIS}`);

    const olderInVancouver = appointmentEvent({ start: "2026-09-02T05:30" });
    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(inZone(timelinePage([olderInVancouver], null), VANCOUVER)),
    );
    let fresh!: (value: unknown) => void;
    actions.listClientTimelineAction.mockReturnValueOnce(
      new Promise((resolve) => (fresh = resolve)),
    );
    fireEvent.click(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    );
    await flush();

    // Meanwhile: what was shown stays, under its own zone, marked as re-read.
    expect(lastTimelineInput()).toEqual({ clientId: CLIENT_ID, limit: 20 });
    expect(history().getAllByRole("article")).toHaveLength(1);
    expect(
      history().queryByText(/05:30/), // the Vancouver page was dropped
    ).toBeNull();
    expect(zoneLabel()).toBe(`Heures de ${PARIS}`);
    expect(history().getByRole("status").textContent).toBe(
      "Actualisation de l’historique…",
    );
    expect(
      history().queryByRole("button", { name: "Afficher plus ancien" }),
    ).toBeNull();

    const recent = appointmentEvent({ start: "2026-10-02T05:30" });
    fresh(ok(inZone(timelinePage([recent], "v1"), VANCOUVER)));
    await flush();
    expect(zoneLabel()).toBe(`Heures de ${VANCOUVER}`);
    expect(history().getAllByRole("article")).toHaveLength(1);
    expect(history().getByText(/05:30 – /)).toBeTruthy();
    expect(history().queryByRole("status")).toBeNull();
    // Not presented as older events added.
    expect(history().queryByText(/plus ancien.* ajouté/)).toBeNull();
    expect(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    ).toBeTruthy();
  });

  it("same zone on every page: appended, no restart", async () => {
    await renderProfile(profile(), [appointmentEvent()], "c1");
    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(timelinePage([appointmentEvent({ start: "2026-08-02T14:30" })])),
    );
    fireEvent.click(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    );
    await flush();
    expect(actions.listClientTimelineAction).toHaveBeenCalledTimes(2);
    expect(history().getAllByRole("article")).toHaveLength(2);
    expect(zoneLabel()).toBe(`Heures de ${PARIS}`);
  });

  it("a failed restart keeps the history shown, under its own zone, marked out of date; retry replaces it", async () => {
    await renderProfile(profile(), [appointmentEvent()], "c1");
    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(inZone(timelinePage([appointmentEvent()]), VANCOUVER)),
    );
    actions.listClientTimelineAction.mockResolvedValueOnce(fail("network"));
    fireEvent.click(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    );
    await flush();
    await flush();

    expect(history().getAllByRole("article")).toHaveLength(1);
    expect(zoneLabel()).toBe(`Heures de ${PARIS}`);
    expect(history().getByRole("alert").textContent).toMatch(
      /L’historique n’a pas pu être actualisé.*peut ne plus être à jour/,
    );
    expect(
      history().queryByRole("button", { name: "Afficher plus ancien" }),
    ).toBeNull();
    const calls = actions.listClientTimelineAction.mock.calls.length;
    await flush();
    expect(actions.listClientTimelineAction.mock.calls.length).toBe(calls);

    actions.listClientTimelineAction.mockResolvedValueOnce(
      ok(
        inZone(
          timelinePage([appointmentEvent(), appointmentEvent()]),
          VANCOUVER,
        ),
      ),
    );
    fireEvent.click(history().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(history().getAllByRole("article")).toHaveLength(2);
    expect(zoneLabel()).toBe(`Heures de ${VANCOUVER}`);
    expect(history().queryByRole("alert")).toBeNull();
  });

  it("a refused cursor whose restart fails keeps the history shown", async () => {
    await renderProfile(profile(), [appointmentEvent()], "stale");
    actions.listClientTimelineAction.mockResolvedValueOnce(
      fail("validation_error", { cursor: ["invalid"] }),
    );
    actions.listClientTimelineAction.mockResolvedValueOnce(fail("internal"));
    fireEvent.click(
      history().getByRole("button", { name: "Afficher plus ancien" }),
    );
    await flush();
    await flush();
    expect(history().getAllByRole("article")).toHaveLength(1);
    expect(history().getByRole("alert").textContent).toMatch(
      /n’a pas pu être actualisé/,
    );
  });

  it("an empty history still names its zone", async () => {
    await renderProfile(profile(), []);
    expect(zoneLabel()).toBe(`Heures de ${PARIS}`);
    expect(history().getByText(/Pas encore d’historique/)).toBeTruthy();
  });

  it("business-local midnight and the repeated autumn hour, as read, never re-computed", async () => {
    await renderProfile(
      profile(),
      [
        {
          ...appointmentEvent({
            start: "2026-10-25T02:30",
            end: "2026-10-25T03:00",
          }),
          occurredAt: at("2026-10-25T02:30", "second"),
        },
        appointmentEvent({
          start: "2026-10-24T00:00",
          end: "2026-10-24T01:00",
        }),
      ].map((event, index) =>
        index === 0
          ? {
              ...event,
              appointment: {
                ...event.appointment,
                startsAt: at("2026-10-25T02:30", "second"),
              },
            }
          : event,
      ) as ClientTimelineEvent[],
    );
    expect(
      history()
        .getAllByRole("time")
        .map((time) => time.getAttribute("datetime")),
    ).toEqual(["2026-10-25", "2026-10-24"]);
    expect(history().getByText(/02:30 \(heure d’hiver\) – 03:00/)).toBeTruthy();
    expect(history().getByText(/^00:00 – 01:00/)).toBeTruthy();
  });
});

describe("profile reads: only the newest one is ever shown", () => {
  const VANCOUVER = "America/Vancouver";
  const visits = (count: number, timezone = "Europe/Paris") => ({
    ...profile({ overview: { completedCount: count } }),
    timezone,
  });
  const deferred = () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  const shownVisits = () =>
    screen.getByText(/^\d+ visites · /).textContent?.split(" ")[0];
  const reload = () =>
    fireEvent.click(screen.getByRole("button", { name: "Recharger la fiche" }));

  /**
   * Profile read in Paris (11 visits), history in Vancouver: the automatic
   * re-read A starts and stays pending; returns A and the next reads.
   */
  async function renderWithPendingAutomaticRead() {
    const automatic = deferred();
    actions.getClientProfileAction
      .mockResolvedValueOnce(ok(visits(11)))
      .mockReturnValueOnce(automatic.promise);
    actions.listClientTimelineAction.mockResolvedValue(
      ok({ ...timelinePage([appointmentEvent()]), timezone: VANCOUVER }),
    );
    render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
    await flush();
    await flush();
    expect(actions.getClientProfileAction).toHaveBeenCalledTimes(2);
    expect(shownVisits()).toBe("11");
    return automatic;
  }

  it("automatic A, then manual B: B answers first, A's late answer never replaces it", async () => {
    useViewport(false); // the compact line says "N visites · …"
    const automatic = await renderWithPendingAutomaticRead();
    const manual = deferred();
    actions.getClientProfileAction.mockReturnValueOnce(manual.promise);
    reload();
    await flush();

    manual.resolve(ok(visits(13, VANCOUVER)));
    await flush();
    expect(shownVisits()).toBe("13");
    expect(screen.queryByText(/Le fuseau horaire du commerce a changé/)).toBe(
      null,
    );

    automatic.resolve(ok(visits(12))); // Paris, older
    await flush();
    await flush();
    expect(shownVisits()).toBe("13");
    expect(screen.queryByText(/Le fuseau horaire du commerce a changé/)).toBe(
      null,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(actions.getClientProfileAction).toHaveBeenCalledTimes(3);
  });

  it("reverse order: A's answer, arriving while B is pending, is never shown", async () => {
    useViewport(false); // the compact line says "N visites · …"
    const automatic = await renderWithPendingAutomaticRead();
    const manual = deferred();
    actions.getClientProfileAction.mockReturnValueOnce(manual.promise);
    reload();
    await flush();

    automatic.resolve(ok(visits(12, VANCOUVER)));
    await flush();
    expect(shownVisits()).toBe("11"); // still the last applied read

    manual.resolve(ok(visits(13, VANCOUVER)));
    await flush();
    expect(shownVisits()).toBe("13");
    expect(actions.getClientProfileAction).toHaveBeenCalledTimes(3);
  });

  it("a late failure of an older read never replaces a newer result with an error", async () => {
    useViewport(false); // the compact line says "N visites · …"
    const automatic = await renderWithPendingAutomaticRead();
    const first = deferred();
    const second = deferred();
    actions.getClientProfileAction
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    reload(); // manual B
    await flush();
    reload(); // manual C, the notice is still there
    await flush();

    second.resolve(ok(visits(13, VANCOUVER)));
    await flush();
    expect(shownVisits()).toBe("13");

    first.resolve(fail("network"));
    automatic.resolve(fail("internal"));
    await flush();
    expect(shownVisits()).toBe("13");
    expect(screen.queryByText(/La fiche n’a pas pu être chargée/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("another customer: the previous customer's late answer is never shown", async () => {
    const emma = deferred();
    actions.getClientProfileAction
      .mockReturnValueOnce(emma.promise)
      .mockResolvedValueOnce(
        ok(
          profile({
            client: {
              id: "30000000-0000-4000-8000-00000000bbbb",
              displayName: "Inès Benali",
              firstName: "Inès",
              lastName: "Benali",
            },
          }),
        ),
      );
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([appointmentEvent()])),
    );
    const view = render(<ClientProfile scope={SCOPE} clientId={CLIENT_ID} />);
    await flush();
    view.rerender(
      <ClientProfile
        scope={SCOPE}
        clientId="30000000-0000-4000-8000-00000000bbbb"
      />,
    );
    await flush();
    expect(
      screen.getByRole("heading", { level: 1, name: "Inès Benali" }),
    ).toBeTruthy();

    emma.resolve(ok(profile()));
    await flush();
    expect(
      screen.getByRole("heading", { level: 1, name: "Inès Benali" }),
    ).toBeTruthy();
    expect(screen.queryByText("Emma Laurent")).toBeNull();
  });

  it("StrictMode: the first, cleaned-up run of the effect never applies its answer", async () => {
    const first = deferred();
    actions.getClientProfileAction
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok(visits(13)));
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([appointmentEvent()])),
    );
    useViewport(false);
    render(
      <StrictMode>
        <ClientProfile scope={SCOPE} clientId={CLIENT_ID} />
      </StrictMode>,
    );
    await flush();
    expect(shownVisits()).toBe("13");
    first.resolve(ok(visits(12)));
    await flush();
    expect(shownVisits()).toBe("13");
  });
});
