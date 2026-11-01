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
        startDate: "2026-09-27",
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
        name: /voir le mercredi 30 septembre 2026 en détail/,
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

  it("free time on the thread opens the agenda's form at that time", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await user.click(await screen.findByRole("button", { name: "Jour" }));
    const free = await screen.findByRole("button", {
      name: /^Temps libre · .*à partir de 11:\d\d : proposer un rendez-vous ici$/,
    });
    const time = free.textContent!.match(/11:\d\d/)![0];
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
        startDate: "2026-09-27",
        endDate: "2026-10-04",
        includeCancelled: true,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Semaine suivante" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-10-04" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Aujourd’hui" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-09-27" }),
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
    renderEcrin();
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

  it("the pearls pick a day, arrows move a week, today is one tap back", async () => {
    const user = userEvent.setup();
    renderEcrin();
    await screen.findByRole("list", { name: "Déroulé de la journée" });
    expect(screen.queryByRole("button", { name: "Aujourd’hui" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Semaine suivante" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-10-05" }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: /jeudi 8 octobre 2026/ }),
    );
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-10-07" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Aujourd’hui" }));
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: "2026-09-28" }),
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

describe("Écrin agenda — buffers", () => {
  const withBuffer = (
    local: string,
    name: string,
    durationMinutes: number,
  ) => ({
    ...appointment({
      local,
      durationMinutes,
      client: { id: name, displayName: name },
    }),
    bufferMinutes: 60,
  });

  const readWith = (...visits: ReturnType<typeof withBuffer>[]) =>
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: visits })),
    );

  it("week: drawn after the visit, not a target; a click there proposes nothing", async () => {
    useViewport(true);
    const user = userEvent.setup();
    readWith(withBuffer(`${TODAY}T10:00`, "Tina Tampon", 60));
    renderEcrin();
    await screen.findByRole("button", { name: /Tina Tampon/ });
    const held = document.querySelector("[data-buffer]") as HTMLElement;
    expect(held).not.toBeNull();
    expect(held.tagName).toBe("SPAN");
    expect(held.getAttribute("aria-hidden")).toBe("true");
    await user.click(held);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("week: a cancelled visit holds nothing", async () => {
    useViewport(true);
    readWith({
      ...withBuffer(`${TODAY}T10:00`, "Clara Annule", 60),
      status: "cancelled",
    });
    renderEcrin();
    await screen.findByRole("button", { name: /Clara Annule/ });
    expect(document.querySelector("[data-buffer]")).toBeNull();
  });

  it("day: the buffer of a visit over yesterday holds today's first hour, the visit stays out of it", async () => {
    useViewport(false);
    // Over yesterday at 23:30, kept until 00:30 — with a 10-hour buffer in
    // the fixture, until 09:30 today, into her opening at 09:00.
    const night = {
      ...withBuffer("2026-09-28T23:00", "Nora Hier", 30),
      bufferMinutes: 600,
    };
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [night] })),
    );
    vi.setSystemTime(new Date("2026-09-29T06:00:00Z")); // 08:00 in Paris
    renderEcrin();
    const day = within(
      await screen.findByRole("list", { name: "Déroulé de la journée" }),
    );
    expect(
      await day.findByRole("button", {
        name: /à partir de 09:30 : proposer un rendez-vous ici/,
      }),
    ).toBeTruthy();
    expect(day.queryByRole("button", { name: /à partir de 09:00/ })).toBeNull();
    expect(day.queryByRole("button", { name: /Nora Hier/ })).toBeNull();
  });

  it("first day of a week: a buffer from Sunday holds Monday's first hour", async () => {
    useViewport(false);
    const sunday = {
      ...withBuffer("2026-09-27T23:00", "Sia Dimanche", 30),
      bufferMinutes: 600,
    };
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [sunday] })),
    );
    vi.setSystemTime(new Date("2026-09-28T06:00:00Z")); // Monday, 08:00
    renderEcrin({}, "2026-09-28");
    expect(
      await screen.findByRole("button", {
        name: /à partir de 09:30 : proposer un rendez-vous ici/,
      }),
    ).toBeTruthy();
  });

  it("week: a buffer across midnight is drawn on both days", async () => {
    useViewport(true);
    readWith(withBuffer(`${TODAY}T23:30`, "Lou Minuit", 15));
    renderEcrin();
    await screen.findByRole("button", { name: /Lou Minuit/ });
    for (const day of [/Journée du mardi 29/, /Journée du mercredi 30/])
      expect(
        screen.getByRole("group", { name: day }).querySelector("[data-buffer]"),
      ).not.toBeNull();
  });

  it("the autumn change: a buffer runs in real minutes, drawn once", async () => {
    useViewport(true);
    vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
    actions.getAgendaTodayAction.mockImplementation(async () =>
      ok(businessToday()),
    );
    readWith(withBuffer("2026-10-25T01:30", "Ava Automne", 30));
    renderEcrin({}, "2026-10-22");
    const day = await screen.findByRole("group", {
      name: /Journée du dimanche 25/,
    });
    expect(day.querySelector("[data-buffer]")).not.toBeNull();
  });

  it("first day of a week: the read reaches the week before", async () => {
    useViewport(true);
    renderEcrin({ initialDate: "2026-09-28" });
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: "2026-09-27" }),
      ),
    );
  });

  it("the dial counts all free time ahead, even a stretch too short to offer", async () => {
    useViewport(true);
    const user = userEvent.setup();
    // 09:00–19:00 open at 08:00: two visits leave 4 minutes between them.
    vi.setSystemTime(new Date("2026-09-29T06:00:00Z"));
    readWith(
      { ...withBuffer(`${TODAY}T09:00`, "Ana Un", 120), bufferMinutes: 0 },
      { ...withBuffer(`${TODAY}T11:04`, "Bia Deux", 476), bufferMinutes: 0 },
    );
    renderEcrin();
    await user.click(await screen.findByRole("button", { name: "Jour" }));
    expect(await screen.findByText("4 min de temps libre")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /à partir de 11:00/ }),
    ).toBeNull();
  });
});

describe("Écrin thread — now and what is going on", () => {
  beforeEach(() => useViewport(false));

  it("a cancelled visit at this hour: « now » has its own mark", async () => {
    const cancelled = {
      ...appointment({ local: `${TODAY}T09:30` }),
      status: "cancelled" as const,
    };
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [cancelled] })),
    );
    renderEcrin();
    expect(
      await screen.findByRole("listitem", { name: "Il est 10:00" }),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("a visit going on says it itself: no second mark, its progress", async () => {
    const going = appointment({
      local: `${TODAY}T09:30`,
      durationMinutes: 60,
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [going] })),
    );
    renderEcrin();
    expect(
      await screen.findByRole("progressbar", {
        name: "Avancement théorique du créneau",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: /^Il est/ })).toBeNull();
  });

  it("across midnight: own line on both days; overlaps together", async () => {
    const night = appointment({
      local: `${TODAY}T23:30`,
      durationMinutes: 120,
      client: { id: "n", displayName: "Lou Minuit" },
    });
    const other = appointment({
      local: `${TODAY}T23:45`,
      durationMinutes: 30,
      client: { id: "o", displayName: "Eva Soir" },
    });
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments: [night, other] })),
    );
    renderEcrin();
    const capsule = await screen.findByRole("button", { name: /Lou Minuit/ });
    expect(capsule.textContent).toMatch(/jusqu’à demain 01:30/);
    expect(screen.getByText("2 rendez-vous qui se chevauchent")).toBeTruthy();
  });
});

describe("Écrin thread — words that promise nothing false", () => {
  beforeEach(() => useViewport(false));
  const visit = (
    local: string,
    name: string,
    minutes: number,
    status?: string,
  ) => ({
    ...appointment({
      local,
      durationMinutes: minutes,
      client: { id: name, displayName: name },
    }),
    ...(status ? { status: status as "cancelled" } : {}),
  });
  const read = (...appointments: ReturnType<typeof visit>[]) =>
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(agenda(startDate, endDate, { appointments })),
    );

  it("three in a chain are not said to be at the same time", async () => {
    read(
      visit(`${TODAY}T11:00`, "Ana", 60),
      visit(`${TODAY}T11:30`, "Bia", 60),
      visit(`${TODAY}T12:15`, "Cléa", 60),
    );
    renderEcrin();
    expect(
      await screen.findByText("3 rendez-vous qui se chevauchent"),
    ).toBeTruthy();
    expect(screen.queryByText(/En même temps/)).toBeNull();
  });

  it("a cancelled visit alone beside one kept: nothing overlaps", async () => {
    read(
      visit(`${TODAY}T11:00`, "Ana", 60),
      visit(`${TODAY}T11:15`, "Bia", 30, "cancelled"),
    );
    renderEcrin();
    await screen.findByRole("button", { name: /Ana/ });
    expect(screen.queryByText(/qui se chevauchent/)).toBeNull();
  });

  it("free time proposes, it does not promise: never « réservable » or « disponible »", async () => {
    read(visit(`${TODAY}T11:00`, "Ana", 60));
    renderEcrin();
    await screen.findByRole("button", { name: /Ana/ });
    const list = screen.getByRole("list", { name: "Déroulé de la journée" });
    expect(list.textContent).toMatch(/Temps libre · /);
    expect(list.textContent).not.toMatch(/réservable|disponible/i);
    expect(
      within(list).getAllByRole("button", {
        name: /proposer un rendez-vous ici$/,
      }).length,
    ).toBeGreaterThan(0);
  });
});
