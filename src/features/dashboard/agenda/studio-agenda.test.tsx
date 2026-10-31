// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaView } from "@/features/agenda/components/agenda-view";
import { defaultAppearance } from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";

import {
  agenda,
  appointment,
  block,
  businessToday,
  services,
} from "../../../../tests/support/agenda-fixtures";
import { isoWeek } from "./studio-agenda";

// The Studio agenda is the agenda: AgendaView (its reading, its "today"
// checked with PostgreSQL, its panels and actions), drawn by StudioAgenda.
// These tests drive it through the same mocked server actions as the
// Classique agenda's tests.

const actions = {
  getAgendaAction: vi.fn(),
  getAgendaAppointmentAction: vi.fn(),
  getAgendaTodayAction: vi.fn(),
  listAgendaServicesAction: vi.fn(),
  searchAgendaClientsAction: vi.fn(),
  createAppointmentAction: vi.fn(),
  updateAppointmentAction: vi.fn(),
  setAppointmentStatusAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  createBlockAction: vi.fn(),
  updateBlockAction: vi.fn(),
  deleteBlockAction: vi.fn(),
};

vi.mock("@/features/agenda/actions/agenda", () =>
  Object.fromEntries(
    [
      "getAgendaAction",
      "getAgendaAppointmentAction",
      "getAgendaTodayAction",
      "listAgendaServicesAction",
      "searchAgendaClientsAction",
      "createAppointmentAction",
      "updateAppointmentAction",
      "setAppointmentStatusAction",
      "cancelAppointmentAction",
      "createBlockAction",
      "updateBlockAction",
      "deleteBlockAction",
    ].map((name) => [
      name,
      (...args: unknown[]) => actions[name as keyof typeof actions](...args),
    ]),
  ),
);

const ok = <T,>(data: T) => ({ ok: true as const, data });

const TODAY = "2026-09-29"; // Tuesday
const originalMatchMedia = window.matchMedia;

function useViewport(wide: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches:
        query.includes("reduced-motion") ||
        (wide && query.includes("min-width: 768px")),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

function renderStudio(props: Partial<Parameters<typeof AgendaView>[0]> = {}) {
  return render(
    <AppearanceProvider initial={{ ...defaultAppearance, style: "studio" }}>
      <AgendaView today={TODAY} {...props} />
    </AppearanceProvider>,
  );
}

const camille = appointment({ local: `${TODAY}T10:00` });
const lunch = block({
  from: `${TODAY}T12:00`,
  to: `${TODAY}T13:00`,
  reason: "Déjeuner",
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T08:00:00Z")); // 10:00 in Paris
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.listAgendaServicesAction.mockResolvedValue(ok(services));
  actions.searchAgendaClientsAction.mockResolvedValue(ok([]));
  actions.getAgendaTodayAction.mockImplementation(async () =>
    ok(businessToday()),
  );
  actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
    ok(
      agenda(startDate, endDate, { appointments: [camille], blocks: [lunch] }),
    ),
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

describe("Studio agenda — computer", () => {
  beforeEach(() => useViewport(true));

  it("opens on the week as a wall planner, one request for the week", async () => {
    renderStudio();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith({
        startDate: "2026-09-27",
        endDate: "2026-10-04",
        includeCancelled: false,
      }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      `Semaine ${isoWeek("2026-09-28")}`,
    );
    // One booking this week, counted once.
    expect(await screen.findByText(/· 1 rendez.vous/)).toBeTruthy();
    expect(
      screen.getByRole("group", { name: /Journée du mardi 29 septembre/ }),
    ).toBeTruthy();
  });

  it("a visit on the wall opens the agenda's own card", async () => {
    const user = userEvent.setup();
    renderStudio();
    await user.click(
      await screen.findByRole("button", { name: /Camille Roux/ }),
    );
    const card = within(screen.getByRole("dialog"));
    expect(card.getByRole("heading", { name: "Rendez-vous" })).toBeTruthy();
    expect(card.getByText("Camille Roux")).toBeTruthy();
  });

  it("her blocked time opens the agenda's block form", async () => {
    const user = userEvent.setup();
    renderStudio();
    await user.click(
      await screen.findByRole("button", { name: /Déjeuner, 12:00/ }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: "Créneau bloqué",
      }),
    ).toBeTruthy();
  });

  it("« Jour » shows one day in depth, read alone; a day label leads there too", async () => {
    const user = userEvent.setup();
    renderStudio();
    await user.click(
      await screen.findByRole("button", {
        name: "Voir le mercredi 30 septembre 2026 en détail",
      }),
    );
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-29",
        endDate: "2026-09-30",
        includeCancelled: false,
      }),
    );
    expect(
      screen.getByRole("button", { name: "Jour" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Semaine" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-27",
        endDate: "2026-10-04",
        includeCancelled: false,
      }),
    );
  });

  it("free time ahead opens the agenda's form at that time", async () => {
    const user = userEvent.setup();
    renderStudio();
    await user.click(await screen.findByRole("button", { name: "Jour" }));
    await user.click(
      await screen.findByRole("button", {
        // 10:00–11:15, its 10 minutes of buffer, then free until the 12:00 pause.
        name: /Libre · 35 min à partir de 11:25 : nouveau rendez-vous/,
      }),
    );
    const form = within(screen.getByRole("dialog"));
    expect(
      form.getByRole("heading", { name: "Nouveau rendez-vous" }),
    ).toBeTruthy();
    expect((form.getByLabelText("Heure") as HTMLInputElement).value).toBe(
      "11:25",
    );
  });

  it("« Afficher les annulés » reads the week again with them", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByRole("button", { name: /Camille Roux/ });
    await user.click(screen.getByRole("checkbox", { name: /annulés/ }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-27",
        endDate: "2026-10-04",
        includeCancelled: true,
      }),
    );
  });
});

describe("Studio agenda — phone", () => {
  beforeEach(() => useViewport(false));

  it("one day, in order, with « now » and create always at hand", async () => {
    const user = userEvent.setup();
    renderStudio();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith({
        startDate: "2026-09-28",
        endDate: TODAY,
        includeCancelled: false,
      }),
    );
    const day = within(
      await screen.findByRole("list", { name: "Déroulé de la journée" }),
    );
    expect(day.getByRole("button", { name: /Camille Roux/ })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Nouveau rendez-vous" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: "Nouveau rendez-vous",
      }),
    ).toBeTruthy();
  });

  it("the options menu blocks time and shows cancelled visits", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByRole("list", { name: "Déroulé de la journée" });
    await user.click(
      screen.getByRole("button", { name: "Options de l’agenda" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /annulés/ }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-28",
        endDate: TODAY,
        includeCancelled: true,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Bloquer un créneau" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: "Bloquer un créneau",
      }),
    ).toBeTruthy();
  });

  it("week arrows move by seven days; the strip picks a day", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByRole("list", { name: "Déroulé de la journée" });
    await user.click(screen.getByRole("button", { name: "Semaine suivante" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-10-05",
        endDate: "2026-10-06",
        includeCancelled: false,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "jeudi 8 octobre 2026" }),
    );
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-10-07",
        endDate: "2026-10-08",
        includeCancelled: false,
      }),
    );
    // Away from today: back in one tap (PostgreSQL says which day it is).
    await user.click(screen.getByRole("button", { name: "Aujourd’hui" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-28",
        endDate: TODAY,
        includeCancelled: false,
      }),
    );
  });
});

describe("Studio agenda — a link from « Aujourd’hui » (?rdv=)", () => {
  beforeEach(() => useViewport(true));

  it("opens the card once its day is read", async () => {
    renderStudio({ initialDate: TODAY, initialAppointmentId: camille.id });
    const card = within(await screen.findByRole("dialog"));
    expect(card.getByText("Camille Roux")).toBeTruthy();
  });

  it("never over a form she opened meanwhile (her draft is kept)", async () => {
    const user = userEvent.setup();
    let answer: (value: unknown) => void = () => {};
    actions.getAgendaAction.mockImplementationOnce(
      () => new Promise((done) => (answer = done)),
    );
    renderStudio({ initialDate: TODAY, initialAppointmentId: camille.id });
    await user.click(
      screen.getByRole("button", { name: /Nouveau rendez-vous/ }),
    );
    const form = within(await screen.findByRole("dialog"));
    await user.type(form.getByLabelText(/Note interne/), "Brouillon");
    answer(ok(agenda("2026-09-28", "2026-10-04", { appointments: [camille] })));
    await screen.findByRole("button", { name: /Camille Roux/ });
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: "Nouveau rendez-vous",
      }),
    ).toBeTruthy();
    expect(
      (
        within(screen.getByRole("dialog")).getByLabelText(
          /Note interne/,
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Brouillon");
  });
});

describe("Studio agenda — hard cases", () => {
  beforeEach(() => useViewport(true));

  it("a network error is said, with a retry, as in the Classique agenda", async () => {
    const user = userEvent.setup();
    actions.getAgendaAction.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    renderStudio();
    expect(await screen.findByText("Connexion interrompue")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(
      await screen.findByRole("button", { name: /Camille Roux/ }),
    ).toBeTruthy();
  });

  it("the autumn change: both 02:30 are on the wall, each where it really is", async () => {
    vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
    actions.getAgendaTodayAction.mockImplementation(async () =>
      ok(businessToday()),
    );
    const first = appointment({
      local: "2026-10-25T02:30",
      occurrence: "first",
      durationMinutes: 30,
      client: { id: "a", displayName: "Avant Changement" },
    });
    const second = appointment({
      local: "2026-10-25T02:30",
      occurrence: "second",
      durationMinutes: 30,
      client: { id: "b", displayName: "Après Changement" },
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [first, second] })),
    );
    render(
      <AppearanceProvider initial={{ ...defaultAppearance, style: "studio" }}>
        <AgendaView today="2026-10-22" />
      </AppearanceProvider>,
    );
    const before = await screen.findByRole("button", {
      name: /Avant Changement/,
    });
    const after = screen.getByRole("button", { name: /Après Changement/ });
    // Same wall clock, two real instants: never on top of each other.
    expect(before.style.left).not.toBe(after.style.left);
    expect(parseFloat(before.style.left)).toBeLessThan(
      parseFloat(after.style.left),
    );
    expect(before.getAttribute("aria-label")).toMatch(/02:30/);
  });

  it("a visit across midnight is on both rows of the wall", async () => {
    const night = appointment({
      local: `${TODAY}T23:30`,
      durationMinutes: 120,
      client: { id: "n", displayName: "Lou Minuit" },
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [night] })),
    );
    renderStudio();
    const tuesday = within(
      await screen.findByRole("group", { name: /Journée du mardi 29/ }),
    );
    const wednesday = within(
      screen.getByRole("group", { name: /Journée du mercredi 30/ }),
    );
    expect(tuesday.getByRole("button", { name: /Lou Minuit/ })).toBeTruthy();
    expect(
      wednesday.getAllByRole("button", { hidden: true }).length,
    ).toBeGreaterThan(0);
    // One booking in the week, not two.
    expect(await screen.findByText(/· 1 rendez.vous/)).toBeTruthy();
  });
});

describe("Studio agenda — back to the tab", () => {
  beforeEach(() => useViewport(true));

  function setVisibility(state: "hidden" | "visible") {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("after more than a minute away, the week is read again; a glance away is not", async () => {
    renderStudio();
    await screen.findByRole("button", { name: /Camille Roux/ });
    const reads = actions.getAgendaAction.mock.calls.length;

    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 20_000);
    setVisibility("visible");
    expect(actions.getAgendaAction.mock.calls.length).toBe(reads);

    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 5 * 60_000);
    setVisibility("visible");
    await waitFor(() =>
      expect(actions.getAgendaAction.mock.calls.length).toBe(reads + 1),
    );
  });
});

describe("Studio agenda — the buffer (ST2-002)", () => {
  it("phone: a visit over yesterday still holds the first minutes through its buffer", async () => {
    useViewport(false);
    // Monday: opening from midnight; Sunday's visit ended at 23:50.
    const sunday = appointment({
      local: "2026-09-27T23:00",
      durationMinutes: 50,
      bufferMinutes: 30,
      client: { id: "s", displayName: "Veille Tampon" },
    });
    vi.setSystemTime(new Date("2026-09-27T22:05:00Z")); // 00:05 on Monday
    actions.getAgendaTodayAction.mockImplementation(async () =>
      ok(businessToday()),
    );
    actions.getAgendaAction.mockImplementation(
      async ({ startDate, endDate }) => {
        const read = agenda(startDate, endDate, { appointments: [sunday] });
        return ok({
          ...read,
          workingHours: {
            ...read.workingHours,
            days: read.workingHours.days.map((day) =>
              day.date === "2026-09-28"
                ? {
                    ...day,
                    openRanges: [
                      {
                        startsAt: day.startsAt,
                        endsAt: new Date(
                          Date.parse(day.startsAt) + 3_600_000,
                        ).toISOString(),
                        localStartsAt: "2026-09-28T00:00",
                        localEndsAt: "2026-09-28T01:00",
                      },
                    ],
                  }
                : { ...day, openRanges: [] },
            ),
          },
        });
      },
    );
    renderStudio({ today: "2026-09-28" });
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-27",
        endDate: "2026-09-28",
        includeCancelled: false,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /Libre · 40 min à partir de 00:20/,
      }),
    ).toBeTruthy();
    // Her buffer holds time; her visit is not on this day.
    expect(screen.queryByRole("button", { name: /Veille Tampon/ })).toBeNull();
  });

  it("wall: the buffer is drawn and proposes nothing", async () => {
    useViewport(true);
    const user = userEvent.setup();
    const { container } = renderStudio();
    await screen.findByRole("button", { name: /Camille Roux/ });
    const held = container.querySelectorAll("[data-buffer]");
    expect(held.length).toBe(1);
    await user.click(held[0]!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("wall: a cancelled visit holds no buffer", async () => {
    useViewport(true);
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(
        agenda(startDate, endDate, {
          appointments: [{ ...camille, status: "cancelled" }],
        }),
      ),
    );
    const { container } = renderStudio();
    await screen.findByRole("button", { name: /Camille Roux/ });
    expect(container.querySelectorAll("[data-buffer]").length).toBe(0);
  });
});

describe("Studio agenda — the « now » marker (ST2-004)", () => {
  it("phone: there with the cancelled visit hidden, and shown", async () => {
    useViewport(false);
    const user = userEvent.setup();
    // 10:00 in Paris: a cancelled visit from 09:30 to 10:30.
    const cancelled = {
      ...appointment({ local: `${TODAY}T09:30`, durationMinutes: 60 }),
      status: "cancelled" as const,
    };
    actions.getAgendaAction.mockImplementation(
      async ({ startDate, endDate, includeCancelled }) =>
        ok(
          agenda(startDate, endDate, {
            appointments: includeCancelled ? [cancelled] : [],
          }),
        ),
    );
    renderStudio();
    expect(await screen.findByLabelText("Il est 10:00")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Options de l’agenda" }),
    );
    await user.click(screen.getByLabelText("Afficher les annulés"));
    await screen.findByRole("button", { name: /Camille Roux.*Annulé/ });
    expect(screen.getByLabelText("Il est 10:00")).toBeTruthy();
    // Nothing is said to be going on.
    expect(screen.queryByText("Créneau en cours")).toBeNull();
  });
});

describe("Studio agenda — the summary (ST2-003)", () => {
  it("the free figure counts a ten-minute opening", async () => {
    useViewport(true);
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const user = userEvent.setup();
    const visit = appointment({
      local: `${TODAY}T11:00`,
      durationMinutes: 50,
      bufferMinutes: 0,
    });
    actions.getAgendaAction.mockImplementation(
      async ({ startDate, endDate }) => {
        const read = agenda(startDate, endDate, { appointments: [visit] });
        return ok({
          ...read,
          workingHours: {
            ...read.workingHours,
            days: read.workingHours.days.map((day) =>
              day.date === TODAY
                ? {
                    ...day,
                    openRanges: [
                      {
                        startsAt: visit.startsAt,
                        endsAt: new Date(
                          Date.parse(visit.endsAt) + 600_000,
                        ).toISOString(),
                        localStartsAt: `${TODAY}T11:00`,
                        localEndsAt: `${TODAY}T12:00`,
                      },
                    ],
                  }
                : day,
            ),
          },
        });
      },
    );
    renderStudio();
    await user.click(await screen.findByRole("button", { name: "Jour" }));
    const summary = await screen.findByRole("complementary", {
      name: "La journée en bref",
    });
    await within(summary).findByText("10 min");
    expect(
      screen.getByRole("button", { name: /Libre · 10 min à partir de 11:50/ }),
    ).toBeTruthy();
  });
});

describe("isoWeek", () => {
  it.each([
    ["2026-01-01", 1],
    ["2026-10-26", 44],
    ["2027-01-03", 53],
    ["2020-12-31", 53],
    ["2021-01-04", 1],
  ])("%s → %i", (date, week) => {
    expect(isoWeek(date)).toBe(week);
  });
});
