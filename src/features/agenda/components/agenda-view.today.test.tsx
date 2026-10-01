// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agenda,
  appointment,
  block,
  businessToday,
  services,
} from "../../../../tests/support/agenda-fixtures";
import { TODAY_TIMEOUT_MS } from "../client/today-tracker";
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
const HOUR = 60 * MINUTE;

// Two independent clocks.
// - The SERVER: `server.now`. PostgreSQL's date, the end of that date and the
//   server instant all derive from it (simulated; production code only ever
//   receives them).
// - The DEVICE: the fake Date / performance / timers of this test.
//   It runs continuously: while the device is awake it advances with real
//   elapsed time (the fake monotonic clock), plus what passed during sleeps.
const server = {
  ahead: 0,
  get now() {
    return this.ahead + performance.now();
  },
};
let businessZone = "Europe/Paris";
const pgToday = () => businessToday(businessZone, server.now);

/** Real time passes: both clocks advance, device timers run. */
const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const flush = () => pass(0);
/**
 * The device sleeps (or its tab is frozen): `ms` pass on the server while no
 * device timer runs and its monotonic clock stands still. Its wall clock
 * shows `wallMs` more (all of it by default; less for a clock that lags).
 */
function sleep(ms: number, wallMs = ms) {
  server.ahead += ms;
  vi.setSystemTime(Date.now() + wallMs);
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

async function renderAgenda(strict = false) {
  const view = <AgendaView today={pgToday().date} slug="studio-mila" />;
  const rendered = render(strict ? <StrictMode>{view}</StrictMode> : view);
  await flush();
  return rendered;
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
/** Display hint only: does the screen believe today is in view? */
const onToday = () => todayButton().getAttribute("data-on-today") === "true";
const dialog = () => screen.queryByRole("dialog");
const fieldValue = (label: string | RegExp) =>
  (within(dialog()!).getByLabelText(label) as HTMLInputElement).value;
const closePanel = () => fireEvent.keyDown(document, { key: "Escape" });
const waiting = () =>
  screen.queryByRole("progressbar", { name: "Chargement de l’agenda" }) !==
  null;

async function click(element: HTMLElement) {
  fireEvent.click(element);
  await flush();
}

/**
 * A transport that holds every answer to "what is today?". Each answer is
 * PostgreSQL's snapshot taken when the request STARTED, delivered when the
 * test says so: a request sent before midnight says "yesterday" even if it
 * is delivered after midnight.
 */
function holdToday() {
  const held: ((value: unknown) => void)[] = [];
  const snapshots: ReturnType<typeof pgToday>[] = [];
  actions.getAgendaTodayAction.mockImplementation(() => {
    snapshots.push(pgToday());
    return new Promise((resolve) => held.push(resolve));
  });
  const deliver = async (index: number) => {
    held[index]!(ok(snapshots[index]!));
    await flush();
  };
  return {
    held,
    snapshots,
    deliver,
    /** Delivers the most recent request. */
    release: () => deliver(held.length - 1),
  };
}

// Thursday 1 Oct 2026, 23:50 in Paris (UTC+2): Paris midnight is 22:00Z.
const THURSDAY_2350 = at("2026-10-01T21:50:00Z");
// Sunday 4 Oct 2026, 23:50: the next day starts a new week.
const SUNDAY_2350 = at("2026-10-04T21:50:00Z");

function startAt(serverNow: number, deviceSkew = 0) {
  server.ahead = serverNow - performance.now();
  vi.setSystemTime(new Date(serverNow + deviceSkew));
}

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
  startAt(SUNDAY_2350);
  businessZone = "Europe/Paris";
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.listAgendaServicesAction.mockResolvedValue(ok(services));
  actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
    ok({
      ...agenda(startDate, endDate, { timeZone: businessZone }),
      today: pgToday().date,
    }),
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

describe("display: same day", () => {
  it("1. starts on PostgreSQL's date, verified once on mount", async () => {
    await renderAgenda();
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    expect(onToday()).toBe(true);
    expect(todayCalls()).toBe(1);
  });

  it("2 & 15. nothing more is asked while the day lasts, whatever wakes the tab", async () => {
    startAt(at("2026-10-04T08:00:00Z")); // Sunday 10:00
    await renderAgenda();

    await pass(30 * MINUTE); // 60 clock ticks
    for (const hours of [5, 7]) {
      sleep(hours * HOUR); // still Sunday in Paris
      act(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
      });
      setVisibility("hidden");
      setVisibility("visible");
      await pass(5 * MINUTE);
    }

    expect(todayCalls()).toBe(1);
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1);
    expect(onToday()).toBe(true);
  });

  it("15. one request per day change over several days, never more", async () => {
    await renderAgenda();
    for (let day = 0; day < 3; day += 1) {
      await pass(20 * MINUTE); // through midnight, 40 clock ticks
      sleep(24 * HOUR - 20 * MINUTE); // …then asleep until 23:50
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
    }
    // Mount + one per midnight: the wake-ups found the date still running.
    expect(todayCalls()).toBe(1 + 3);
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1);
  });
});

describe("display: midnight with the tab active (desktop, Sunday → Monday)", () => {
  it("3 & 4. asks PostgreSQL once at the boundary and shows the new date", async () => {
    await renderAgenda();
    await pass(10 * MINUTE - 1_000);
    expect(todayCalls()).toBe(1);
    expect(onToday()).toBe(true);

    await pass(MINUTE);
    expect(todayCalls()).toBe(2);
    expect(onToday()).toBe(false); // the week on screen is now last week
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1); // nothing reloaded behind the user
  });

  it.each([
    ["10 minutes late", -10 * MINUTE],
    ["2 hours late", -2 * HOUR],
    ["10 minutes ahead", 10 * MINUTE],
    ["2 hours ahead", 2 * HOUR],
    ["24 hours late", -24 * HOUR],
    ["24 hours ahead", 24 * HOUR],
  ])(
    "device clock %s: the date changes at the server's midnight",
    async (_label, skew) => {
      startAt(SUNDAY_2350, skew);
      await renderAgenda();
      expect(onToday()).toBe(true);
      await pass(9 * MINUTE);
      expect(onToday()).toBe(true);
      await pass(MINUTE + 1_000);
      expect(onToday()).toBe(false);
      expect(todayCalls()).toBe(2);
    },
  );
});

describe("actions always ask PostgreSQL first", () => {
  beforeEach(() => startAt(THURSDAY_2350));

  it("5, 6 & 7. Aujourd’hui, Nouveau rendez-vous and Bloquer each validate the date", async () => {
    await renderAgenda();
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-01");
    closePanel();
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-01");
    closePanel();
    await click(todayButton());
    expect(todayCalls()).toBe(1 + 3);

    await pass(11 * MINUTE); // Friday 00:01
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-02");
    closePanel();
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-02");
  });

  it("Sunday → Monday: Aujourd’hui goes to the new week; a creation never prefills the day before", async () => {
    startAt(SUNDAY_2350);
    await renderAgenda();
    await pass(11 * MINUTE);

    await click(button(/Nouveau rendez-vous/));
    // Today (Monday) is not on screen: first working day of the week shown.
    expect(fieldValue("Date")).toBe("2026-09-28");
    closePanel();

    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-05");
  });

  // Codex's reproduction: two independent clocks.
  it("A. device late — server 2 Oct 00:05, device 1 Oct 23:55, cached today 1 Oct", async () => {
    startAt(THURSDAY_2350, -10 * MINUTE); // device 23:40
    await renderAgenda();
    // 15 minutes later nothing has run on the device (timers suspended).
    sleep(15 * MINUTE);
    expect(new Date().toISOString()).toBe("2026-10-01T21:55:00.000Z");
    expect(pgToday().date).toBe("2026-10-02");
    expect(onToday()).toBe(true); // the screen still shows the cached 1 Oct
    const before = todayCalls();

    await click(button(/Nouveau rendez-vous/));
    expect(todayCalls()).toBeGreaterThan(before); // PostgreSQL was asked
    expect(fieldValue("Date")).toBe("2026-10-02");
    closePanel();

    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-02");
    closePanel();
  });

  it("A. device late: Aujourd’hui is not disabled and goes to PostgreSQL's date", async () => {
    startAt(SUNDAY_2350, -10 * MINUTE);
    await renderAgenda();
    sleep(15 * MINUTE); // server: Monday 00:05; device: Sunday 23:55
    expect(todayButton().disabled).toBe(false);

    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("B. device very late: the server has been on the next day for hours", async () => {
    await renderAgenda();
    // Nine hours on the server; the device's clocks did not move at all.
    server.ahead += 9 * HOUR;
    expect(onToday()).toBe(true);

    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-02");
    closePanel();
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-02");
    closePanel();

    startAt(SUNDAY_2350 + 9 * HOUR, -9 * HOUR);
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("C. device ahead — it believes midnight has passed, PostgreSQL does not", async () => {
    startAt(THURSDAY_2350, 20 * MINUTE); // device: 2 Oct 00:10
    await renderAgenda();
    await pass(5 * MINUTE);
    expect(todayCalls()).toBe(1); // no early storm either

    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-01");
    closePanel();
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-01");
    closePanel();
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    expect(onToday()).toBe(true);
  });

  it.each([1_000, 3_000, 30_000])(
    "D. small skew (%i ms): no trust window lets the old date through",
    async (skew) => {
      // The last answer arrives one second before midnight on a device that
      // is `skew` late.
      startAt(at("2026-10-01T21:59:59Z"), -skew);
      await renderAgenda();
      for (const later of [2_000, 60_000, 4 * MINUTE]) {
        sleep(later, 0); // the device notices nothing
        await click(button(/Nouveau rendez-vous/));
        expect(fieldValue("Date")).toBe("2026-10-02");
        closePanel();
      }
    },
  );

  it("E. sleep: timers and the monotonic clock stopped; the action after wake-up validates", async () => {
    await renderAgenda();
    sleep(9 * HOUR);
    // No event has reached the page yet.
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-02");
  });
});

describe("an action never shares a read started before it", () => {
  // Codex's reproduction. A: a display read sent at 21:59:59Z (still the
  // previous day in Paris), held in the transport. The user acts at
  // 22:00:02Z, after midnight. A is delivered at 22:00:05Z.
  async function displayReadHeldOverMidnight(day: "thursday" | "sunday") {
    startAt(
      at(day === "thursday" ? "2026-10-01T21:59:59Z" : "2026-10-04T21:59:59Z"),
    );
    const today = holdToday();
    await renderAgenda(); // A: the verification on mount
    expect(today.held).toHaveLength(1);
    await pass(3_000); // 22:00:02Z
    return today;
  }

  it.each([
    ["Nouveau rendez-vous", /Nouveau rendez-vous/, "Date"],
    ["Bloquer un créneau", /Bloquer un créneau/, "Début — date"],
  ] as const)(
    "%s: A (1 Oct) delivered after the click does not open the form; B (2 Oct) does",
    async (_label, name, field) => {
      const today = await displayReadHeldOverMidnight("thursday");
      expect(today.snapshots[0]!.date).toBe("2026-10-01");

      fireEvent.click(button(name));
      expect(today.held).toHaveLength(2); // B, sent after the click
      expect(today.snapshots[1]!.date).toBe("2026-10-02");

      await pass(3_000); // 22:00:05Z
      await today.deliver(0); // A
      expect(dialog()).toBeNull();
      expect(waiting()).toBe(true);

      await today.deliver(1); // B
      expect(fieldValue(field)).toBe("2026-10-02");
    },
  );

  it("Aujourd’hui, Sunday → Monday: A does not keep the old week; B goes to the new one", async () => {
    const today = await displayReadHeldOverMidnight("sunday");
    fireEvent.click(todayButton());
    expect(today.held).toHaveLength(2);

    await pass(3_000);
    await today.deliver(0); // A: "Sunday"
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    expect(waiting()).toBe(true);

    await today.deliver(1); // B: Monday
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(onToday()).toBe(true);
  });

  it("B delivered first, then A: no way back — cache, highlight, week", async () => {
    const today = await displayReadHeldOverMidnight("sunday");
    fireEvent.click(todayButton());
    await today.deliver(1); // B
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(onToday()).toBe(true);
    const agendaReads = actions.getAgendaAction.mock.calls.length;

    await today.deliver(0); // A, at last: "Sunday"
    await pass(MINUTE);
    expect(onToday()).toBe(true); // Monday is still today on screen
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(actions.getAgendaAction.mock.calls.length).toBe(agendaReads);

    actions.getAgendaTodayAction.mockImplementation(async () => ok(pgToday()));
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-05");
  });

  it("an action just before midnight uses ITS read (1 Oct), whenever it is delivered", async () => {
    startAt(THURSDAY_2350);
    await renderAgenda();
    sleep(9 * MINUTE + 59_500, 9 * MINUTE + 59_500); // 21:59:59.500Z
    const today = holdToday();

    fireEvent.click(button(/Bloquer un créneau/));
    const mine = today.held.length - 1;
    expect(today.snapshots[mine]!.date).toBe("2026-10-01");
    await pass(4_000); // delivered after midnight
    await today.deliver(mine);
    expect(fieldValue("Début — date")).toBe("2026-10-01");
  });

  it("an action whose read never answers is not satisfied by A; only the retry's read runs it", async () => {
    const today = await displayReadHeldOverMidnight("thursday");
    fireEvent.click(button(/Nouveau rendez-vous/)); // B
    await pass(2_000);
    await today.deliver(0); // A answers meanwhile
    expect(dialog()).toBeNull();
    expect(waiting()).toBe(true);

    await pass(TODAY_TIMEOUT_MS); // B is given up
    expect(waiting()).toBe(false);
    expect(dialog()).toBeNull();
    const asked = today.held.length;
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" })); // C
    expect(today.held.length).toBe(asked + 1);

    await today.deliver(1); // B answers at last
    expect(dialog()).toBeNull();
    await today.deliver(asked); // C
    expect(fieldValue("Date")).toBe("2026-10-02");
  });
});

describe("display: suspended tabs and delayed timers", () => {
  it("8. hidden at midnight, visible the next day: asked once, when it comes back", async () => {
    await renderAgenda();
    setVisibility("hidden");
    await pass(20 * MINUTE); // through midnight: timers fire, nobody is looking
    sleep(9 * HOUR);
    expect(todayCalls()).toBe(1);

    setVisibility("visible");
    await flush();
    expect(todayCalls()).toBe(2);
    expect(onToday()).toBe(false);
  });

  it("9. device asleep (no timer ran), window focused the next day", async () => {
    await renderAgenda();
    sleep(9 * HOUR);
    expect(todayCalls()).toBe(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(todayCalls()).toBe(2);
    expect(onToday()).toBe(false);
  });

  it("back two days later: one request for the display, the right week on Aujourd’hui", async () => {
    await renderAgenda();
    sleep(41 * HOUR); // Tuesday 6 Oct
    setVisibility("visible");
    await flush();
    expect(todayCalls()).toBe(2);

    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-06");
  });
});

describe("the business time zone decides, as PostgreSQL resolves it", () => {
  it("11. Vancouver business on a Kiritimati device", async () => {
    businessZone = "America/Vancouver";
    startAt(at("2026-10-05T06:50:00Z")); // Sunday 4 Oct, 23:50 PDT
    await renderAgenda();
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    expect(new Date().getDate()).toBe(5); // the device is already on Monday evening

    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-04");
    closePanel();

    await pass(11 * MINUTE); // Vancouver midnight is 07:00Z
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("tzdata divergence: the date changes when PostgreSQL says so, not when the runtime's rules would", async () => {
    // PostgreSQL ends Sunday one hour later than this runtime's tzdata would
    // (the Vancouver case of docs/ARCHITECTURE.md §8).
    const postgres = () =>
      server.now < at("2026-10-04T23:00:00Z")
        ? { date: "2026-10-04", endsAt: "2026-10-04T23:00:00.000Z" }
        : { date: "2026-10-05", endsAt: "2026-10-05T23:00:00.000Z" };
    actions.getAgendaTodayAction.mockImplementation(async () =>
      ok({ ...postgres(), now: new Date(server.now).toISOString() }),
    );
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok({ ...agenda(startDate, endDate), today: postgres().date }),
    );
    await renderAgenda();

    await pass(40 * MINUTE); // 22:30Z: Monday for Intl, still Sunday for PostgreSQL
    expect(todayCalls()).toBe(1);
    expect(onToday()).toBe(true);
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-04");
    closePanel();

    await pass(31 * MINUTE); // 23:01Z
    expect(onToday()).toBe(false);
  });
});

describe("network failure", () => {
  beforeEach(() => {
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok({
        ...agenda(startDate, endDate, {
          appointments: [
            appointment({
              startsAt: "2026-10-02T08:00:00.000Z",
              endsAt: "2026-10-02T09:15:00.000Z",
            }),
          ],
        }),
        today: pgToday().date,
      }),
    );
  });

  it("12. keeps the agenda and its data, invents no date, never claims an expired session", async () => {
    await renderAgenda();
    // The request itself fails in transport (the probe finds no network).
    actions.getAgendaTodayAction.mockRejectedValue(new TypeError("offline"));
    await pass(11 * MINUTE);

    expect(screen.getAllByText(/Camille Roux/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Session expirée/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Me reconnecter" })).toBeNull();
    expect(actions.getAgendaAction).toHaveBeenCalledTimes(1);
    expect(onToday()).toBe(false); // uncertain: nothing shown as today

    // An action that needs today reports the failure instead of guessing.
    await click(button(/Nouveau rendez-vous/));
    expect(dialog()).toBeNull();
    expect(screen.getByText(/Connexion/)).toBeTruthy();
    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    const retry = screen.getByRole("button", { name: "Réessayer" });

    actions.getAgendaTodayAction.mockImplementation(async () => ok(pgToday()));
    await click(retry);
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("12. the display retries by itself with a growing delay, not in a loop", async () => {
    await renderAgenda();
    actions.getAgendaTodayAction.mockRejectedValue(new TypeError("offline"));
    await pass(10 * MINUTE + 30 * MINUTE); // half an hour offline after midnight
    // At 0 s, then after 30 s, 60 s, 120 s, 240 s, 480 s, 600 s…
    const offline = todayCalls() - 1;
    expect(offline).toBeGreaterThanOrEqual(5);
    expect(offline).toBeLessThanOrEqual(7);

    actions.getAgendaTodayAction.mockImplementation(async () => ok(pgToday()));
    await pass(11 * MINUTE);
    const settled = todayCalls();
    await pass(20 * MINUTE);
    expect(todayCalls()).toBe(settled);
    expect(onToday()).toBe(false); // Monday, known again
    await click(todayButton());
    expect(onToday()).toBe(true);
  });
});

describe("a pending action never overrides what the user did since", () => {
  const loaded = appointment({
    startsAt: "2026-10-01T08:00:00.000Z",
    endsAt: "2026-10-01T09:15:00.000Z",
    version: 2,
    internalNotes: "Allergie colle",
  });
  const formation = block({
    from: "2026-09-30T12:30",
    to: "2026-09-30T15:00",
    version: 4,
  });

  beforeEach(() => {
    startAt(THURSDAY_2350);
    actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
      ok({
        ...agenda(startDate, endDate, {
          appointments: [loaded],
          blocks: [formation],
        }),
        today: pgToday().date,
      }),
    );
  });

  it("Codex: block creation pending → open appointment → Modifier → type a note → today answers", async () => {
    await renderAgenda();
    const today = holdToday();

    fireEvent.click(button(/Bloquer un créneau/)); // waits for today
    expect(waiting()).toBe(true);

    await click(screen.getByRole("button", { name: /Camille Roux/ }));
    await click(within(dialog()!).getByRole("button", { name: "Modifier" }));
    const note = within(dialog()!).getByLabelText(/Note interne/);
    fireEvent.change(note, { target: { value: "Allergie colle + latex" } });

    await today.release();

    expect(screen.getByRole("dialog", { name: "Modifier le rendez-vous" }));
    expect(fieldValue(/Note interne/)).toBe("Allergie colle + latex");
    expect(within(dialog()!).queryByLabelText("Début — date")).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Bloquer un créneau" }),
    ).toBeNull();
    expect(waiting()).toBe(false);
  });

  it("appointment creation pending → open a block for editing", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(button(/Nouveau rendez-vous/));

    await click(screen.getByRole("button", { name: /Bloqué · Formation/ }));
    fireEvent.change(within(dialog()!).getByLabelText(/Motif/), {
      target: { value: "Formation cils" },
    });
    await today.release();

    expect(screen.getByRole("dialog", { name: "Créneau bloqué" }));
    expect(fieldValue(/Motif/)).toBe("Formation cils");
    expect(
      screen.queryByRole("dialog", { name: "Nouveau rendez-vous" }),
    ).toBeNull();
  });

  it("pending → open details only", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(button(/Bloquer un créneau/));
    await click(screen.getByRole("button", { name: /Camille Roux/ }));
    await today.release();
    expect(screen.getByRole("dialog", { name: "Rendez-vous" }));
  });

  it("pending → a panel opened then closed: nothing reopens", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(button(/Nouveau rendez-vous/));
    await click(screen.getByRole("button", { name: /Camille Roux/ }));
    closePanel();
    await flush();
    expect(dialog()).toBeNull();

    await today.release();
    expect(dialog()).toBeNull();
    expect(waiting()).toBe(false);
  });

  it("pending → creation at an explicit time on the grid", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(button(/Bloquer un créneau/));

    const column = screen
      .getAllByRole("group", { name: "mercredi 30 septembre 2026" })
      .flatMap((group) => [group, ...group.querySelectorAll("div")])
      .find((element) => {
        fireEvent.click(element);
        return dialog() !== null;
      });
    expect(column).toBeTruthy();
    await flush();
    expect(screen.getByRole("dialog", { name: "Nouveau rendez-vous" }));
    expect(fieldValue("Date")).toBe("2026-09-30");

    await today.release();
    expect(screen.getByRole("dialog", { name: "Nouveau rendez-vous" }));
    expect(fieldValue("Date")).toBe("2026-09-30");
  });

  it.each([
    ["in the order they were sent", [0, 1]],
    ["in the reverse order", [1, 0]],
  ])(
    "two pending actions, answers %s: only the last action runs",
    async (_label, order) => {
      await renderAgenda();
      const today = holdToday();
      fireEvent.click(button(/Bloquer un créneau/));
      fireEvent.click(button(/Nouveau rendez-vous/));
      expect(today.held).toHaveLength(2); // each action has its own read

      for (const index of order) await today.deliver(index);

      expect(screen.getByRole("dialog", { name: "Nouveau rendez-vous" }));
      expect(
        screen.queryByRole("dialog", { name: "Bloquer un créneau" }),
      ).toBeNull();
    },
  );

  it("old display read A pending → action B → the user opens a panel (C) → B answers → A answers: C stays", async () => {
    startAt(at("2026-10-01T21:59:59Z"));
    const today = holdToday(); // A: the verification on mount, held
    await renderAgenda();
    expect(today.held).toHaveLength(1);

    await pass(3_000);
    fireEvent.click(button(/Bloquer un créneau/)); // B
    expect(today.held).toHaveLength(2);
    await click(screen.getByRole("button", { name: /Camille Roux/ })); // C
    await click(within(dialog()!).getByRole("button", { name: "Modifier" }));
    fireEvent.change(within(dialog()!).getByLabelText(/Note interne/), {
      target: { value: "Note en cours" },
    });

    await today.deliver(1); // B
    await today.deliver(0); // A
    expect(screen.getByRole("dialog", { name: "Modifier le rendez-vous" }));
    expect(fieldValue(/Note interne/)).toBe("Note en cours");
    expect(waiting()).toBe(false);
  });

  it("pending Aujourd’hui → the user changes week: the navigation wins", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(todayButton());
    await click(button("Semaine précédente"));
    expect(lastAgendaRange()).toBe("2026-09-21..2026-09-27");

    await today.release();
    expect(lastAgendaRange()).toBe("2026-09-21..2026-09-27");
  });

  it("pending creation → the user changes week: no form appears later", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(button(/Nouveau rendez-vous/));
    await click(button("Semaine suivante"));
    await today.release();
    expect(dialog()).toBeNull();
  });

  it("a very late answer after navigation: no form, no error, no jump", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(button(/Bloquer un créneau/));
    await click(button("Semaine suivante"));
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");

    await pass(TODAY_TIMEOUT_MS + 1_000); // the request is given up
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    await today.deliver(0); // …and answers at last
    expect(dialog()).toBeNull();
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("a failure of a superseded action is not reported either", async () => {
    await renderAgenda();
    const today = holdToday();
    fireEvent.click(button(/Nouveau rendez-vous/));
    await click(screen.getByRole("button", { name: /Camille Roux/ }));
    today.held[0]!({ ok: false, error: { code: "internal", message: "x" } });
    await flush();
    expect(screen.getByRole("dialog", { name: "Rendez-vous" }));
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
  });
});

describe("a request that never answers", () => {
  it("does not hang the action: error at the deadline; its late answer is ignored; retry works", async () => {
    startAt(THURSDAY_2350);
    await renderAgenda();
    const today = holdToday();

    fireEvent.click(button(/Nouveau rendez-vous/));
    await pass(TODAY_TIMEOUT_MS - 1_000);
    expect(waiting()).toBe(true);
    expect(dialog()).toBeNull(); // waiting, not guessing
    await pass(1_500);
    expect(waiting()).toBe(false);
    const retry = screen.getByRole("button", { name: "Réessayer" });
    expect(dialog()).toBeNull();

    await today.deliver(0); // the abandoned request answers: nothing happens
    expect(dialog()).toBeNull();

    await pass(15 * MINUTE); // Friday now
    fireEvent.click(retry);
    await today.release();
    expect(fieldValue("Date")).toBe("2026-10-02");
  });

  it("Strict Mode: same guarantees after setup → clean-up → setup", async () => {
    startAt(THURSDAY_2350);
    const today = holdToday();
    await renderAgenda(true);

    fireEvent.click(button(/Nouveau rendez-vous/));
    await pass(TODAY_TIMEOUT_MS + 1_000); // eleven seconds
    expect(waiting()).toBe(false);
    expect(dialog()).toBeNull();
    const retry = screen.getByRole("button", { name: "Réessayer" });
    // Only the screen's clock is left: no orphan deadline or boundary timer.
    expect(vi.getTimerCount()).toBe(1);

    // Nothing blocks the next actions: the retry sends a new request…
    const asked = today.held.length;
    fireEvent.click(retry);
    expect(today.held.length).toBe(asked + 1);
    await today.release();
    expect(fieldValue("Date")).toBe("2026-10-01");
    closePanel();

    // …and so does any other action.
    actions.getAgendaTodayAction.mockImplementation(async () => ok(pgToday()));
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-01");
  });
});

describe("concurrent refreshes and stale answers", () => {
  it("13. timer, focus, visibility and ticks share one display read; each click has its own", async () => {
    await renderAgenda();
    const today = holdToday();
    await pass(10 * MINUTE + 1_000); // boundary timer: display read in flight
    expect(today.held).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    setVisibility("visible");
    await pass(5_000);
    expect(today.held).toHaveLength(1);

    fireEvent.click(todayButton()); // during the display read
    fireEvent.click(todayButton());
    await flush();
    expect(today.held).toHaveLength(3);
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04"); // waiting, not guessing

    await today.deliver(0); // the display read does not satisfy a click
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    await today.deliver(1); // nor does the superseded first click
    expect(lastAgendaRange()).toBe("2026-09-28..2026-10-04");
    await today.deliver(2);
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
  });

  it("13. an answer older than what an agenda read already brought is ignored", async () => {
    await renderAgenda();
    const today = holdToday();
    const sunday = pgToday();
    await pass(10 * MINUTE + 1_000); // asked at the boundary, still pending

    // The agenda read of the next week comes back first, saying Monday.
    await click(button("Semaine suivante"));
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-11");
    expect(onToday()).toBe(true);

    // The older answer finally arrives, saying Sunday.
    today.held[0]!(ok(sunday));
    await flush();
    expect(onToday()).toBe(true); // still Monday
  });
});

describe("clean-up", () => {
  it("14. removes its listeners and timers, and ignores an answer after unmount", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    [document, window].forEach((target) => {
      vi.spyOn(target, "addEventListener").mockImplementation(
        (type: string) => void added.push(type),
      );
      vi.spyOn(target, "removeEventListener").mockImplementation(
        (type: string) => void removed.push(type),
      );
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const view = await renderAgenda();
    const today = holdToday();
    const wake = ["visibilitychange", "focus", "pageshow"];
    expect(added.filter((type) => wake.includes(type)).sort()).toEqual(
      [...wake].sort(),
    );
    await pass(10 * MINUTE + 1_000); // a display read…
    fireEvent.click(button(/Nouveau rendez-vous/)); // …and an action read
    expect(today.held).toHaveLength(2);

    view.unmount();
    expect(removed.filter((type) => wake.includes(type)).sort()).toEqual(
      [...wake].sort(),
    );
    expect(vi.getTimerCount()).toBe(0);

    await today.deliver(0);
    await today.deliver(1);
    sleep(40 * HOUR);
    await pass(MINUTE);
    expect(today.held).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("phone (one day on screen)", () => {
  beforeEach(() => useViewport(false));

  it("day view, week strip, Aujourd’hui and creation after midnight", async () => {
    await renderAgenda();
    expect(lastAgendaRange()).toBe("2026-10-04..2026-10-04");
    expect(onToday()).toBe(true);

    await pass(11 * MINUTE);
    expect(onToday()).toBe(false);

    // The day on screen is the default of a creation, whatever today is.
    const asked = todayCalls();
    await click(button(/Nouveau rendez-vous/));
    expect(fieldValue("Date")).toBe("2026-10-04");
    expect(todayCalls()).toBe(asked);
    closePanel();

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
    closePanel();
    await click(button(/Bloquer un créneau/));
    expect(fieldValue("Début — date")).toBe("2026-10-05");
  });

  it("left open over midnight on a device that is late, back the next morning", async () => {
    startAt(SUNDAY_2350, -30 * MINUTE);
    await renderAgenda();
    setVisibility("hidden");
    sleep(9 * HOUR); // Monday 08:50 on the server
    setVisibility("visible");
    await flush();
    expect(onToday()).toBe(false);

    await click(todayButton());
    expect(lastAgendaRange()).toBe("2026-10-05..2026-10-05");
  });

  it("pending Aujourd’hui → creation on the day shown: the form stays, the day does not jump", async () => {
    await renderAgenda();
    await pass(11 * MINUTE);
    const today = holdToday();
    fireEvent.click(todayButton());
    await click(button(/Nouveau rendez-vous/)); // explicit day: opens at once
    expect(fieldValue("Date")).toBe("2026-10-04");

    await today.release();
    expect(fieldValue("Date")).toBe("2026-10-04");
    expect(lastAgendaRange()).toBe("2026-10-04..2026-10-04");
  });
});
