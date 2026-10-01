// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agenda,
  appointment,
  services,
} from "../../../../tests/support/agenda-fixtures";
import { TODAY_TIMEOUT_MS } from "../client/use-canonical-today";
import { AgendaView } from "./agenda-view";

// The device is never in the business time zone in this file: UTC+14, a
// calendar day ahead of Paris for most of the day and of Vancouver always.
process.env.TZ = "Pacific/Kiritimati";

const actions = {
  getAgendaAction: vi.fn(),
  getAgendaTodayAction: vi.fn(),
  listAgendaServicesAction: vi.fn(),
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
      (...args: unknown[]) =>
        (actions as Record<string, (...input: unknown[]) => unknown>)[name]?.(
          ...args,
        ),
    ]),
  ),
);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const at = (value: string) => new Date(value).getTime();
const MINUTE = 60_000;

// PostgreSQL, simulated: the business's date at the (fake) current instant
// and the instant that date ends. Production code only ever receives these.
let businessZone = "Europe/Paris";
function pgToday() {
  const date = agenda("2026-01-01", "2026-01-01", {
    timeZone: businessZone,
  }).today;
  const day = agenda(date, date, { timeZone: businessZone }).workingHours
    .days[0]!;
  return { date, endsAt: day.endsAt };
}

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

let visibility: DocumentVisibilityState = "visible";
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Lets time pass with timers running (an active tab). */
const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const flush = () => pass(0);
/** Time passes while timers do NOT run (device asleep, suspended tab). */
function sleepUntil(instant: string) {
  vi.setSystemTime(new Date(instant));
}

async function renderAgenda() {
  const view = render(<AgendaView today={pgToday()} slug="studio-mila" />);
  await flush();
  return view;
}

const todayCalls = () => actions.getAgendaTodayAction.mock.calls.length;
const lastAgendaRange = () => {
  const calls = actions.getAgendaAction.mock.calls;
  const { startDate, endDate } = calls[calls.length - 1]![0];
  return `${startDate}..${endDate}`;
};
const button = (name: RegExp | string) =>
  screen.getAllByRole("button", { name })[0] as HTMLButtonElement;
const todayButton = () => button("Aujourd’hui");
const dialog = () => screen.queryByRole("dialog");
const fieldValue = (label: string) =>
  (within(dialog()!).getByLabelText(label) as HTMLInputElement).value;

async function click(element: HTMLElement) {
  fireEvent.click(element);
  await flush();
}

// Sunday 4 Oct 2026, 23:50 in Paris (UTC+2). Paris midnight is 22:00Z:
// Monday 5 Oct starts a new week.
const SUNDAY_2350 = "2026-10-04T21:50:00Z";
const PARIS_MIDNIGHT = at("2026-10-04T22:00:00Z");

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(SUNDAY_2350));
  businessZone = "Europe/Paris";
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.listAgendaServicesAction.mockResolvedValue(ok(services));
  actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
    ok(agenda(startDate, endDate, { timeZone: businessZone })),
  );
  actions.getAgendaTodayAction.mockImplementation(async () => ok(pgToday()));
  useViewport(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
  delete (document as { visibilityState?: unknown }).visibilityState;
});

it("runs with a device time zone that is not the business's", () => {
  expect(new Date(SUNDAY_2350).getTimezoneOffset()).toBe(-14 * 60);
  // Monday on the device, still Sunday for the business.
  expect(new Date(SUNDAY_2350).getDate()).toBe(5);
  expect(pgToday().date).toBe("2026-10-04");
});

describe("same day", () => {
  it("1. starts on the date PostgreSQL gave, without asking again", async () => {
    await renderAgenda();
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    expect(todayButton().disabled).toBe(true);
    expect(todayCalls()).toBe(0);
  });

  it("2 & 15. nothing is asked while the day lasts: no polling, whatever wakes the tab", async () => {
    vi.setSystemTime(new Date("2026-10-04T08:00:00Z")); // Sunday 10:00
    await renderAgenda();

    await pass(30 * MINUTE); // 60 clock ticks
    for (const later of ["2026-10-04T14:00:00Z", "2026-10-04T21:30:00Z"]) {
      sleepUntil(later); // still Sunday in Paris
      act(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
      });
      setVisibility("hidden");
      setVisibility("visible");
      await pass(5 * MINUTE);
    }

    expect(todayCalls()).toBe(0);
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1);
    expect(todayButton().disabled).toBe(true);

    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-04");
    expect(todayCalls()).toBe(0);
  });

  it("15. one request per day change over several days, never more", async () => {
    await renderAgenda();
    for (const beforeMidnight of [
      "2026-10-04T21:59:00Z",
      "2026-10-05T21:59:00Z",
      "2026-10-06T21:59:00Z",
    ]) {
      sleepUntil(beforeMidnight);
      await pass(20 * MINUTE); // through midnight, 40 clock ticks
    }
    expect(todayCalls()).toBe(3);
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1);
  });
});

describe("midnight with the tab active (desktop, Sunday → Monday)", () => {
  it("3 & 4. asks PostgreSQL once at the boundary and takes the new date", async () => {
    await renderAgenda();
    await pass(PARIS_MIDNIGHT - Date.now() - 1);
    expect(todayCalls()).toBe(0);
    expect(todayButton().disabled).toBe(true);

    await pass(MINUTE);
    expect(todayCalls()).toBe(1);
    // The week on screen is now last week: the button works again…
    expect(todayButton().disabled).toBe(false);
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1); // nothing reloaded behind the user
  });

  it("5. Aujourd’hui goes to the new week", async () => {
    await renderAgenda();
    await pass(11 * MINUTE);

    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(todayButton().disabled).toBe(true);
    expect(todayCalls()).toBe(1);
  });

  it("6. Nouveau rendez-vous: the day before is never prefilled once it is over", async () => {
    await renderAgenda();
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-04"); // today, 23:50
    fireEvent.keyDown(document, { key: "Escape" });

    await pass(11 * MINUTE); // 00:01 on Monday; last week still on screen
    await click(button(/Nouveau rendez-vous/));
    // Today (Monday) is not on screen: first working day of the week shown.
    expect(fieldValue("Date")).toBe("2026-09-28");
    fireEvent.keyDown(document, { key: "Escape" });

    await click(todayButton());
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-05");
  });

  it("7. Bloquer un créneau follows the same rule", async () => {
    await renderAgenda();
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-04");
    fireEvent.keyDown(document, { key: "Escape" });

    await pass(11 * MINUTE);
    await click(todayButton());
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-05");
  });

  it("23:59 → 00:00 inside the same week: the default day moves with PostgreSQL's date", async () => {
    vi.setSystemTime(new Date("2026-09-29T21:59:00Z")); // Tuesday 23:59
    await renderAgenda();
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-09-29");
    fireEvent.keyDown(document, { key: "Escape" });

    await pass(MINUTE + 1_000); // Wednesday 00:00:01
    expect(todayButton().disabled).toBe(true); // same week
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-09-30");
    expect(todayCalls()).toBe(1);
  });
});

describe("suspended tabs and delayed timers", () => {
  it("8. hidden at midnight, visible the next day: asked once, when it comes back", async () => {
    await renderAgenda();
    setVisibility("hidden");
    await pass(20 * MINUTE); // through midnight: timers fire, nobody is looking
    sleepUntil("2026-10-05T07:00:00Z");
    expect(todayCalls()).toBe(0);

    setVisibility("visible");
    await flush();
    expect(todayCalls()).toBe(1);
    expect(todayButton().disabled).toBe(false);
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("9. device asleep (no timer ran), window focused the next day", async () => {
    await renderAgenda();
    sleepUntil("2026-10-05T07:00:00Z");
    expect(todayCalls()).toBe(0);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(todayCalls()).toBe(1);
    expect(todayButton().disabled).toBe(false);
  });

  it("10. timer never fired and no event: the action itself checks first", async () => {
    await renderAgenda();
    sleepUntil("2026-10-04T22:00:05Z"); // Monday 00:00:05, nothing ran
    // The stale date still looks current on screen…
    expect(todayButton().disabled).toBe(true);

    // …but a creation asks PostgreSQL before choosing a day.
    await click(button(/Nouveau rendez-vous/));
    expect(todayCalls()).toBe(1);
    expect(fieldValue("Date")).toBe("2026-09-28"); // never Sunday 4 Oct
    fireEvent.keyDown(document, { key: "Escape" });
    expect(todayButton().disabled).toBe(false);
  });

  it("back two days later: one request, the right week", async () => {
    await renderAgenda();
    sleepUntil("2026-10-06T15:00:00Z"); // Tuesday 6 Oct
    setVisibility("visible");
    await flush();
    expect(todayCalls()).toBe(1);

    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-09-28");
    fireEvent.keyDown(document, { key: "Escape" });
    await click(todayButton());
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-06");
    expect(todayCalls()).toBe(1);
  });
});

describe("the business time zone decides, as PostgreSQL resolves it", () => {
  it("11. Vancouver business on a Kiritimati device", async () => {
    businessZone = "America/Vancouver";
    vi.setSystemTime(new Date("2026-10-05T06:50:00Z")); // Sunday 4 Oct, 23:50 PDT
    await renderAgenda();
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    expect(new Date().getDate()).toBe(5); // the device is already on Monday evening

    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-04");
    fireEvent.keyDown(document, { key: "Escape" });

    await pass(11 * MINUTE); // Vancouver midnight is 07:00Z
    expect(todayCalls()).toBe(1);
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("tzdata divergence: the date changes when PostgreSQL says so, not when the runtime's rules would", async () => {
    // PostgreSQL ends Sunday one hour later than this runtime's tzdata would
    // (the Vancouver case of docs/ARCHITECTURE.md §8).
    const pg = { date: "2026-10-04", endsAt: "2026-10-04T23:00:00.000Z" };
    actions.getAgendaAction.mockImplementation(
      async ({ startDate, endDate }) => {
        const data = agenda(startDate, endDate);
        data.today = pg.date;
        data.workingHours.days.find((day) => day.date === pg.date)!.endsAt =
          pg.endsAt;
        return ok(data);
      },
    );
    const view = render(<AgendaView today={pg} slug="studio-mila" />);
    await flush();
    actions.getAgendaTodayAction.mockResolvedValue(
      ok({ date: "2026-10-05", endsAt: "2026-10-05T23:00:00.000Z" }),
    );

    await pass(40 * MINUTE); // 22:30Z: Monday for Intl, still Sunday for PostgreSQL
    expect(todayCalls()).toBe(0);
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-04");
    fireEvent.keyDown(document, { key: "Escape" });

    await pass(31 * MINUTE); // 23:01Z
    expect(todayCalls()).toBe(1);
    expect(todayButton().disabled).toBe(false);
    view.unmount();
  });
});

describe("network failure while refreshing", () => {
  beforeEach(() => {
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok(
        agenda(startDate, endDate, {
          appointments: [
            appointment({
              startsAt: "2026-10-02T08:00:00.000Z",
              endsAt: "2026-10-02T09:15:00.000Z",
            }),
          ],
        }),
      ),
    );
    // The request itself fails in transport (the probe finds no network).
    actions.getAgendaTodayAction.mockRejectedValue(new TypeError("offline"));
  });

  it("12. keeps the agenda and its data, invents no date, never claims an expired session", async () => {
    await renderAgenda();
    await pass(11 * MINUTE);
    expect(todayCalls()).toBeGreaterThan(0);

    expect(screen.getAllByText(/Camille Roux/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Session expirée/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Me reconnecter" })).toBeNull();
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1);

    // An action that needs today reports the failure instead of guessing.
    await click(button(/Nouveau rendez-vous/));
    expect(dialog()).toBeNull();
    expect(screen.getByText(/Connexion/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Réessayer" });

    // Aujourd’hui is not stuck disabled on the old date, and does not move
    // anywhere without an answer.
    expect(todayButton().disabled).toBe(false);
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");

    actions.getAgendaTodayAction.mockImplementation(async () => ok(pgToday()));
    await click(screen.getByRole("button", { name: "Réessayer" }));
    expect(retry.isConnected).toBe(false);
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("12. retries by itself with a growing delay, not in a loop", async () => {
    await renderAgenda();
    await pass(10 * MINUTE + 30 * MINUTE); // half an hour offline after midnight
    // At 0 s, then after 30 s, 60 s, 120 s, 240 s, 480 s, 600 s…: at most
    // 7 attempts in 30 minutes (60 clock ticks).
    expect(todayCalls()).toBeGreaterThanOrEqual(5);
    expect(todayCalls()).toBeLessThanOrEqual(7);

    actions.getAgendaTodayAction.mockImplementation(async () => ok(pgToday()));
    await pass(11 * MINUTE);
    const settled = todayCalls();
    await pass(20 * MINUTE);
    expect(todayCalls()).toBe(settled);
    expect(todayButton().disabled).toBe(false);
  });
});

describe("a request that never answers", () => {
  it("does not hang the action: error after the deadline, and the late answer still counts", async () => {
    let answer!: (value: unknown) => void;
    actions.getAgendaTodayAction.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    await renderAgenda();
    sleepUntil("2026-10-04T22:00:05Z");

    fireEvent.click(button(/Nouveau rendez-vous/));
    await pass(TODAY_TIMEOUT_MS - 1_000);
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(dialog()).toBeNull(); // waiting, not guessing
    await pass(1_500);
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    expect(dialog()).toBeNull();

    answer(ok(pgToday()));
    await flush();
    expect(todayButton().disabled).toBe(false);
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(todayCalls()).toBe(1);
  });
});

describe("concurrent refreshes and stale answers", () => {
  function deferredToday() {
    const resolvers: ((value: unknown) => void)[] = [];
    actions.getAgendaTodayAction.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    return resolvers;
  }

  it("13. timer, focus, visibility and a click share one request", async () => {
    await renderAgenda();
    const pending = deferredToday();
    await pass(10 * MINUTE + 1_000); // boundary timer: request in flight
    expect(todayCalls()).toBe(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    setVisibility("visible");
    await pass(5_000);
    fireEvent.click(todayButton()); // exactly during the refresh
    fireEvent.click(todayButton());
    await flush();
    expect(todayCalls()).toBe(1);
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04"); // waiting, not guessing

    pending[0]!(ok(pgToday()));
    await flush();
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(todayCalls()).toBe(1);
  });

  it("13. a navigation made while waiting wins over the pending Aujourd’hui", async () => {
    await renderAgenda();
    const pending = deferredToday();
    await pass(10 * MINUTE + 1_000);
    fireEvent.click(todayButton());
    await click(button("Semaine précédente"));
    expect(lastAgendaRange()).toBe("2026-09-21..2026-09-27");

    pending[0]!(ok(pgToday()));
    await flush();
    expect(lastAgendaRange()).toBe("2026-09-21..2026-09-27");
    expect(todayButton().disabled).toBe(false);
  });

  it("13. an answer older than what an agenda read already brought is ignored", async () => {
    await renderAgenda();
    const pending = deferredToday();
    await pass(10 * MINUTE + 1_000); // refresh asked first, still pending

    // The agenda read of the next week comes back first, with Monday and its
    // real bounds.
    await click(button("Semaine suivante"));
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(todayButton().disabled).toBe(true);

    // The older answer finally arrives, saying Sunday.
    pending[0]!(ok({ date: "2026-10-04", endsAt: "2026-10-04T22:00:00.000Z" }));
    await flush();
    expect(todayButton().disabled).toBe(true); // still Monday
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-05");
    expect(todayCalls()).toBe(1);
  });
});

describe("clean-up", () => {
  it("14. removes its listeners and timers, and ignores an answer after unmount", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const spies = [document, window].flatMap((target) => [
      vi
        .spyOn(target, "addEventListener")
        .mockImplementation((type: string) => void added.push(type)),
      vi
        .spyOn(target, "removeEventListener")
        .mockImplementation((type: string) => void removed.push(type)),
    ]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolve!: (value: unknown) => void;
    actions.getAgendaTodayAction.mockImplementation(
      () => new Promise((done) => (resolve = done)),
    );

    const view = await renderAgenda();
    const wake = ["visibilitychange", "focus", "pageshow"];
    expect(added.filter((type) => wake.includes(type)).sort()).toEqual(
      [...wake].sort(),
    );
    await pass(10 * MINUTE + 1_000);
    expect(todayCalls()).toBe(1);

    view.unmount();
    expect(removed.filter((type) => wake.includes(type)).sort()).toEqual(
      [...wake].sort(),
    );
    expect(vi.getTimerCount()).toBe(0);

    resolve(ok(pgToday()));
    sleepUntil("2026-10-06T10:00:00Z");
    await pass(MINUTE);
    expect(todayCalls()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    spies.forEach((spy) => spy.mockRestore());
    errors.mockRestore();
  });
});

describe("phone (one day on screen)", () => {
  beforeEach(() => useViewport(false));

  it("day view, week strip, Aujourd’hui and creation after midnight", async () => {
    await renderAgenda();
    expect(lastAgendaRange()).toBe("2026-10-04..2026-10-04");
    expect(todayButton().disabled).toBe(true);

    await pass(11 * MINUTE);
    expect(todayCalls()).toBe(1);
    expect(todayButton().disabled).toBe(false);

    // The day on screen is the default of a creation, whatever today is.
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-04");
    fireEvent.keyDown(document, { key: "Escape" });

    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-05");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Lundi 5 octobre",
    );
    // The strip shows the new week, Monday selected.
    const strip = screen.getByRole("group", { name: "Jours de la semaine" });
    expect(
      within(strip)
        .getByRole("button", { name: "lundi 5 octobre 2026" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-05");
    fireEvent.keyDown(document, { key: "Escape" });
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-05");
    expect(todayCalls()).toBe(1);
  });

  it("left open over midnight, back in the app the next morning", async () => {
    await renderAgenda();
    setVisibility("hidden");
    sleepUntil("2026-10-05T06:30:00Z"); // Monday 08:30, no timer ran
    setVisibility("visible");
    await flush();

    expect(todayCalls()).toBe(1);
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-05");
  });
});
