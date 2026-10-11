// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

const actions = {
  getClientProfileAction: vi.fn(),
  listClientTimelineAction: vi.fn(),
};
vi.mock("@/features/crm/actions/crm", () => ({
  listClientsAction: vi.fn(),
  getClientProfileAction: (...args: unknown[]) =>
    actions.getClientProfileAction(...args),
  listClientTimelineAction: (...args: unknown[]) =>
    actions.listClientTimelineAction(...args),
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
  const view = render(<ClientProfile clientId={CLIENT_ID} />);
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
  window.sessionStorage.clear();
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
        "Pas encore d’historique. Ses rendez-vous passés apparaîtront ici.",
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
    expect(contact.getAllByRole("button")).toHaveLength(1);

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

  it("no notes, preferences, editing or customer creation: nothing that does not work", async () => {
    await renderProfile();
    expect(
      screen.queryByRole("button", {
        name: /Modifier|Ajouter une note|Nouvelle cliente|Préférences/,
      }),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(/Notes|Bientôt/);
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
    render(<ClientProfile clientId={CLIENT_ID} />);
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
    render(<ClientProfile clientId={CLIENT_ID} />);
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
    render(<ClientProfile clientId={CLIENT_ID} />);
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
