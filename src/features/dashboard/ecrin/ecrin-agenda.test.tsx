// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  SERVICE_A,
  services,
} from "../../../../tests/support/agenda-fixtures";

// The Écrin agenda is the agenda: AgendaView (its reading, its "today"
// checked with PostgreSQL, its panels, its actions), drawn by EcrinAgenda.
// These tests drive it through the same mocked server actions as the other
// styles' tests: there is no second booking logic to test.

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
const fail = (code: string) => ({
  ok: false as const,
  error: { code, message: "backend text never shown" },
});

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

function renderEcrin(
  props: Partial<Parameters<typeof AgendaView>[0]> = {},
  today = TODAY,
) {
  return render(
    <AppearanceProvider initial={{ ...defaultAppearance, style: "ecrin" }}>
      <AgendaView today={today} {...props} />
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

describe("Écrin agenda — computer", () => {
  beforeEach(() => useViewport(true));

  it("opens on the week, one request; its own tubes, not the Studio wall", async () => {
    renderEcrin();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith({
        startDate: "2026-09-28",
        endDate: "2026-10-04",
        includeCancelled: false,
      }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toMatch(
      /^Semaine \d/,
    );
    expect(await screen.findByText(/· 1 rendez.vous/)).toBeTruthy();
    expect(
      screen.getByRole("group", { name: /Journée du mardi 29 septembre/ }),
    ).toBeTruthy();
  });

  it("a visit opens the agenda's own card; a block its own form", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await user.click(
      await screen.findByRole("button", { name: /Camille Roux/ }),
    );
    const card = within(screen.getByRole("dialog"));
    expect(card.getByRole("heading", { name: "Rendez-vous" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(
      await screen.findByRole("button", { name: /Déjeuner, 12:00/ }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", {
        name: "Créneau bloqué",
      }),
    ).toBeTruthy();
  });

  it("a day's dial leads to that day, read alone; « Semaine » goes back", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await user.click(
      await screen.findByRole("button", {
        name: "Voir le mercredi 30 septembre 2026 en détail",
      }),
    );
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-30",
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
        startDate: "2026-09-28",
        endDate: "2026-10-04",
        includeCancelled: false,
      }),
    );
  });

  it("free time on the thread opens the agenda's form at that time", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await user.click(await screen.findByRole("button", { name: "Jour" }));
    const free = await screen.findByRole("button", {
      name: /^Libre · .* à partir de 11:\d\d : nouveau rendez-vous$/,
    });
    const time = free.getAttribute("aria-label")!.match(/11:\d\d/)![0];
    await user.click(free);
    const form = within(screen.getByRole("dialog"));
    expect(
      form.getByRole("heading", { name: "Nouveau rendez-vous" }),
    ).toBeTruthy();
    expect((form.getByLabelText("Heure") as HTMLInputElement).value).toBe(time);
  });

  it("a slot the server refuses is refused here too: never a success", async () => {
    const user = userEvent.setup();
    actions.searchAgendaClientsAction.mockResolvedValue(
      ok([
        {
          id: "20000000-0000-4000-8000-00000000000a",
          displayName: "Camille Roux",
          email: null,
          phone: null,
        },
      ]),
    );
    actions.createAppointmentAction.mockResolvedValue(
      fail("schedule_conflict"),
    );
    renderEcrin();
    await screen.findByRole("button", { name: /Camille Roux/ });
    await user.click(
      screen.getByRole("button", { name: /Nouveau rendez-vous/ }),
    );
    const form = within(await screen.findByRole("dialog"));
    await waitFor(() =>
      expect(
        (form.getByLabelText("Prestation") as HTMLSelectElement).disabled,
      ).toBe(false),
    );
    await user.selectOptions(form.getByLabelText("Prestation"), SERVICE_A);
    fireEvent.change(form.getByLabelText("Heure"), {
      target: { value: "14:30" },
    });
    await user.type(form.getByLabelText("Rechercher une cliente"), "cam");
    await user.click(await form.findByRole("button", { name: /Camille Roux/ }));
    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );
    expect(
      await form.findByText(
        "Ce créneau vient d’être pris ou est indisponible. Choisis-en un autre.",
      ),
    ).toBeTruthy();
    expect(actions.createAppointmentAction).toHaveBeenCalledTimes(1);
  });

  it("creates through the agenda's action, once, with the form's values", async () => {
    const user = userEvent.setup();
    actions.searchAgendaClientsAction.mockResolvedValue(
      ok([
        {
          id: "20000000-0000-4000-8000-00000000000a",
          displayName: "Camille Roux",
          email: null,
          phone: null,
        },
      ]),
    );
    actions.createAppointmentAction.mockResolvedValue(
      ok({
        appointment: appointment({ local: `${TODAY}T14:30` }),
        created: true,
      }),
    );
    renderEcrin();
    await screen.findByRole("button", { name: /Camille Roux/ });
    await user.click(
      screen.getByRole("button", { name: /Nouveau rendez-vous/ }),
    );
    const form = within(await screen.findByRole("dialog"));
    await waitFor(() =>
      expect(
        (form.getByLabelText("Prestation") as HTMLSelectElement).disabled,
      ).toBe(false),
    );
    await user.selectOptions(form.getByLabelText("Prestation"), SERVICE_A);
    fireEvent.change(form.getByLabelText("Heure"), {
      target: { value: "14:30" },
    });
    await user.type(form.getByLabelText("Rechercher une cliente"), "cam");
    await user.click(await form.findByRole("button", { name: /Camille Roux/ }));
    await user.click(
      form.getByRole("button", { name: "Créer le rendez-vous" }),
    );
    await waitFor(() =>
      expect(actions.createAppointmentAction).toHaveBeenCalledTimes(1),
    );
    expect(actions.createAppointmentAction.mock.calls[0]![0]).toMatchObject({
      date: TODAY,
      time: "14:30",
      serviceId: SERVICE_A,
    });
  });

  it("the card changes a status through the agenda's action", async () => {
    const user = userEvent.setup();
    actions.setAppointmentStatusAction.mockResolvedValue(
      ok({ ...camille, status: "completed" }),
    );
    renderEcrin();
    await user.click(
      await screen.findByRole("button", { name: /Camille Roux/ }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Marquer terminé",
      }),
    );
    // She confirms first: nothing changes before that.
    expect(actions.setAppointmentStatusAction).not.toHaveBeenCalled();
    const dialogs = screen.getAllByRole("dialog");
    await user.click(
      within(dialogs[dialogs.length - 1]!).getByRole("button", {
        name: "Marquer terminé",
      }),
    );
    await waitFor(() =>
      expect(actions.setAppointmentStatusAction).toHaveBeenCalledTimes(1),
    );
    expect(actions.setAppointmentStatusAction.mock.calls[0]![0]).toMatchObject({
      status: "completed",
    });
  });

  it("a week across New Year says both years", async () => {
    vi.setSystemTime(new Date("2026-12-29T09:00:00Z"));
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate)),
    );
    renderEcrin({}, "2026-12-29");
    expect(await screen.findByText(/^2026 – 2027 · /)).toBeTruthy();
  });

  it("the spring change: a visit after the missing hour is drawn, counted once", async () => {
    vi.setSystemTime(new Date("2027-03-26T09:00:00Z"));
    const after = appointment({
      local: "2027-03-28T03:30",
      durationMinutes: 30,
      client: { id: "s", displayName: "Printemps Visite" },
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [after] })),
    );
    renderEcrin({}, "2027-03-26");
    expect(
      await screen.findByRole("button", { name: /Printemps Visite/ }),
    ).toBeTruthy();
    expect(await screen.findByText(/· 1 rendez.vous/)).toBeTruthy();
  });

  it("« Annulés » reads the week again with them; arrows and today move it", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await screen.findByRole("button", { name: /Camille Roux/ });
    await user.click(screen.getByRole("checkbox", { name: /annulés/ }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: "2026-09-28",
        endDate: "2026-10-04",
        includeCancelled: true,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Semaine suivante" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-10-05" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Aujourd’hui" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-09-28" }),
      ),
    );
  });
});

describe("Écrin agenda — phone", () => {
  beforeEach(() => useViewport(false));

  it("one day on its thread, with create at hand", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith({
        startDate: TODAY,
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
    renderEcrin();
    await screen.findByRole("list", { name: "Déroulé de la journée" });
    await user.click(
      screen.getByRole("button", { name: "Options de l’agenda" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /annulés/ }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith({
        startDate: TODAY,
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

  it("the pearls pick a day, arrows move a week, today is one tap back", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await screen.findByRole("list", { name: "Déroulé de la journée" });
    expect(screen.queryByRole("button", { name: "Aujourd’hui" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Semaine suivante" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-10-06" }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "jeudi 8 octobre 2026" }),
    );
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-10-08" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Aujourd’hui" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: TODAY }),
      ),
    );
  });

  it("a day empty, then a day closed, say so without inventing anything", async () => {
    actions.getAgendaAction.mockImplementation(
      async ({ startDate, endDate }) => {
        const empty = agenda(startDate, endDate);
        return ok({
          ...empty,
          workingHours: {
            ...empty.workingHours,
            days: empty.workingHours.days.map((day) => ({
              ...day,
              openRanges: [],
            })),
          },
        });
      },
    );
    renderEcrin();
    expect(await screen.findByText("Fermé")).toBeTruthy();
    expect(screen.getByText("Aucune ouverture ce jour-là.")).toBeTruthy();
  });
});

describe("Écrin agenda — hard cases", () => {
  beforeEach(() => useViewport(true));

  it("a link from « Aujourd’hui » opens the card once its day is read", async () => {
    renderEcrin({ initialDate: TODAY, initialAppointmentId: camille.id });
    const card = within(await screen.findByRole("dialog"));
    expect(card.getByText("Camille Roux")).toBeTruthy();
  });

  it("a network error is said, with a retry", async () => {
    const user = userEvent.setup();
    actions.getAgendaAction.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    renderEcrin();
    expect(await screen.findByText("Connexion interrompue")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(
      await screen.findByRole("button", { name: /Camille Roux/ }),
    ).toBeTruthy();
  });

  it("overlapping visits sit side by side", async () => {
    const a = appointment({
      local: `${TODAY}T14:00`,
      client: { id: "a", displayName: "Ava Premier" },
    });
    const b = appointment({
      local: `${TODAY}T14:15`,
      client: { id: "b", displayName: "Bea Second" },
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [a, b] })),
    );
    renderEcrin();
    const first = await screen.findByRole("button", { name: /Ava Premier/ });
    const second = screen.getByRole("button", { name: /Bea Second/ });
    expect(first.style.left).not.toBe(second.style.left);
  });

  it("the autumn change: both 02:30 are drawn, never on top of each other", async () => {
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
    renderEcrin({}, "2026-10-22");
    const before = await screen.findByRole("button", {
      name: /Avant Changement/,
    });
    const after = screen.getByRole("button", { name: /Après Changement/ });
    expect(`${before.style.top}|${before.style.left}`).not.toBe(
      `${after.style.top}|${after.style.left}`,
    );
  });

  it("across midnight: in both tubes, one booking in the week", async () => {
    const night = appointment({
      local: `${TODAY}T23:30`,
      durationMinutes: 120,
      client: { id: "n", displayName: "Lou Minuit" },
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [night] })),
    );
    renderEcrin();
    const tuesday = within(
      await screen.findByRole("group", { name: /Journée du mardi 29/ }),
    );
    expect(tuesday.getByRole("button", { name: /Lou Minuit/ })).toBeTruthy();
    expect(
      within(
        screen.getByRole("group", { name: /Journée du mercredi 30/ }),
      ).getAllByRole("button", { hidden: true }).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText(/· 1 rendez.vous/)).toBeTruthy();
  });

  it("back after more than a minute, the week is read again; a glance is not", async () => {
    const setVisibility = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    renderEcrin();
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
