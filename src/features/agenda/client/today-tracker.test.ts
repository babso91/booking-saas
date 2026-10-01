// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UiResult } from "@/features/auth/client/call-action";
import type { BusinessTodayDto } from "@/lib/time/business-time";

import { businessToday } from "../../../../tests/support/agenda-fixtures";
import { MIN_REMAINING_MS } from "./today";
import { TODAY_TIMEOUT_MS, TodayTracker } from "./today-tracker";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (value: string) => Date.parse(value);

// Two independent clocks. The SERVER (PostgreSQL's date, the server's
// instant) is `server.now`; the DEVICE is the fake Date / performance.
// The server runs continuously: with real elapsed time while the device is
// awake (the fake monotonic clock), plus what passed during its sleeps.
const server = {
  ahead: 0,
  get now() {
    return this.ahead + performance.now();
  },
  set now(value: number) {
    this.ahead = value - performance.now();
  },
};
const pg = () => businessToday("Europe/Paris", server.now);

/** Real time passes: both clocks advance, device timers run. */
async function pass(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}
/** The device sleeps: its timers and monotonic clock stop, time goes on. */
function sleep(ms: number) {
  server.ahead += ms;
  vi.setSystemTime(Date.now() + ms);
}

type Answer = UiResult<BusinessTodayDto>;
function asking() {
  const pending: ((answer: Answer) => void)[] = [];
  const ask = vi.fn(
    () => new Promise<Answer>((resolve) => pending.push(resolve)),
  );
  return { ask, pending };
}
const answering = () =>
  vi.fn(async (): Promise<Answer> => ({ ok: true, data: pg() }));

let visibility: DocumentVisibilityState = "visible";
const trackers: TodayTracker[] = [];
function tracker(seed: string, ask: () => Promise<Answer>) {
  const created = new TodayTracker(seed, ask);
  trackers.push(created);
  return created;
}

// Thursday 1 Oct 2026, 23:50 in Paris; Paris midnight is 22:00Z.
const SERVER_2350 = at("2026-10-01T21:50:00Z");

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  server.now = SERVER_2350;
  vi.setSystemTime(new Date(SERVER_2350));
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  trackers.splice(0).forEach((created) => created.stop());
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("display cache, timed by the server", () => {
  it("verifies the page's date on start, then asks once when it ends on the server", async () => {
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });

    await pass(10 * MINUTE - 1_000);
    expect(ask).toHaveBeenCalledTimes(1);
    await pass(2_000);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });

    await pass(6 * HOUR); // no polling
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["10 minutes late", -10 * MINUTE],
    ["2 hours late", -2 * HOUR],
    ["10 minutes ahead", 10 * MINUTE],
    ["2 hours ahead", 2 * HOUR],
  ])(
    "device clock %s: the date changes at the server's midnight all the same",
    async (_label, skew) => {
      vi.setSystemTime(new Date(SERVER_2350 + skew));
      const ask = answering();
      const today = tracker("2026-10-01", ask);
      today.start();
      await pass(0);
      expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });

      await pass(9 * MINUTE);
      expect(today.snapshot().date).toBe("2026-10-01");
      expect(ask).toHaveBeenCalledTimes(1);

      await pass(MINUTE + 1_000);
      expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
      expect(ask).toHaveBeenCalledTimes(2);
    },
  );

  it("device ahead: PostgreSQL's date is kept, without a request storm", async () => {
    vi.setSystemTime(new Date(SERVER_2350 + 3 * HOUR)); // device: 2 Oct, 02:50
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(5 * MINUTE);
    for (let tick = 0; tick < 10; tick += 1) today.check();
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("answer a second before midnight: no minutes-long trust, asked again within seconds", async () => {
    server.now = at("2026-10-01T21:59:59Z");
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);
    expect(today.snapshot().date).toBe("2026-10-01");

    await pass(MIN_REMAINING_MS + 500);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });

  it("server clock slightly ahead of PostgreSQL at midnight: a bounded re-ask, not a loop", async () => {
    // PostgreSQL still says 1 Oct while the server stamps 22:00:00.2Z.
    const ask = vi.fn(async (): Promise<Answer> => ({
      ok: true,
      data: {
        date: "2026-10-01",
        endsAt: "2026-10-01T22:00:00.000Z",
        now: "2026-10-01T22:00:00.200Z",
      },
    }));
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(MINUTE);
    expect(ask.mock.calls.length).toBeLessThanOrEqual(
      1 + Math.ceil(MINUTE / MIN_REMAINING_MS),
    );
    expect(today.snapshot().date).toBe("2026-10-01");
  });

  it("sleep: timers and the monotonic clock stopped; the wake-up asks", async () => {
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);

    sleep(9 * HOUR);
    expect(ask).toHaveBeenCalledTimes(1); // nothing ran
    window.dispatchEvent(new Event("focus"));
    await pass(0);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });

  it("hidden tab: nothing is asked until it is visible again", async () => {
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);
    visibility = "hidden";
    await pass(20 * MINUTE);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(today.snapshot().certain).toBe(false); // may be over: not shown as today

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await pass(0);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });

  it("failure: keeps the date, marks it uncertain once over, retries with a growing delay", async () => {
    const ask = vi.fn(async (): Promise<Answer> => ({ ok: true, data: pg() }));
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);
    ask.mockImplementation(async () => ({
      ok: false,
      error: { code: "network" },
    }));

    await pass(10 * MINUTE + 1_000);
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: false });
    const afterBoundary = ask.mock.calls.length;
    // The screen's clock ticks every 30 s for half an hour.
    for (let tick = 0; tick < 60; tick += 1) {
      await pass(30_000);
      today.check();
    }
    expect(ask.mock.calls.length - afterBoundary).toBeLessThanOrEqual(6);
    expect(ask.mock.calls.length - afterBoundary).toBeGreaterThanOrEqual(4);
    expect(today.snapshot().date).toBe("2026-10-01"); // never a guess
  });
});

describe("validate: what an action gets", () => {
  it("always asks PostgreSQL, even when the cache looks current", async () => {
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(MINUTE);
    expect(ask).toHaveBeenCalledTimes(1);

    expect(await today.validate()).toEqual({ ok: true, data: "2026-10-01" });
    expect(await today.validate()).toEqual({ ok: true, data: "2026-10-01" });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("A. device 10 minutes late, timers suspended: PostgreSQL's 2 Oct, not the cached 1 Oct", async () => {
    vi.setSystemTime(new Date(SERVER_2350 - 10 * MINUTE)); // device 23:40
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);
    // Server: 2 Oct 00:05. Device: 1 Oct 23:55, and none of its timers ran.
    sleep(15 * MINUTE);
    expect(new Date().toISOString()).toBe("2026-10-01T21:55:00.000Z");
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });

    expect(await today.validate()).toEqual({ ok: true, data: "2026-10-02" });
  });

  it("B. device clock frozen for hours while the server moved to the next day", async () => {
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);
    server.ahead += 9 * HOUR; // the device saw none of it: no clock moved

    expect(await today.validate()).toEqual({ ok: true, data: "2026-10-02" });
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });

  it("C. device ahead: still PostgreSQL's date", async () => {
    vi.setSystemTime(new Date(SERVER_2350 + 20 * MINUTE)); // device: 2 Oct 00:10
    const today = tracker("2026-10-01", answering());
    today.start();
    expect(await today.validate()).toEqual({ ok: true, data: "2026-10-01" });
  });

  it("D. answer received a second before midnight, action three seconds later", async () => {
    server.now = at("2026-10-01T21:59:59Z");
    const today = tracker("2026-10-01", answering());
    today.start();
    await pass(3_000);
    expect(today.snapshot().date).toBe("2026-10-01"); // display, for 2 more seconds
    expect(await today.validate()).toEqual({ ok: true, data: "2026-10-02" });
  });

  it("concurrent callers share one request", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const first = today.validate();
    const second = today.validate();
    window.dispatchEvent(new Event("focus"));
    today.check();
    expect(ask).toHaveBeenCalledTimes(1);

    pending[0]!({ ok: true, data: pg() });
    expect(await first).toEqual({ ok: true, data: "2026-10-01" });
    expect(await second).toEqual({ ok: true, data: "2026-10-01" });
  });
});

describe("a request always ends, and an ended request never comes back", () => {
  it("never answers: network error at the deadline, then a retry works", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const result = today.validate();
    let settled = false;
    void result.then(() => (settled = true));

    await pass(TODAY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await pass(1);
    expect(await result).toEqual({ ok: false, error: { code: "network" } });
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: false });

    const retry = today.validate();
    expect(ask).toHaveBeenCalledTimes(2);
    pending[1]!({ ok: true, data: pg() });
    expect(await retry).toEqual({ ok: true, data: "2026-10-01" });
    expect(today.snapshot().certain).toBe(true);
  });

  it("answer just before the deadline: applied", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const result = today.validate();
    await pass(TODAY_TIMEOUT_MS - 1);
    pending[0]!({ ok: true, data: pg() });
    expect(await result).toEqual({ ok: true, data: "2026-10-01" });
    await pass(10);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("answer in the same instant as the deadline: one outcome only, whichever came first", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const result = today.validate();
    const outcomes: unknown[] = [];
    void result.then((value) => outcomes.push(value));
    await pass(TODAY_TIMEOUT_MS); // the deadline fires first…
    pending[0]!({ ok: true, data: pg() }); // …the answer right behind
    await pass(0);
    expect(outcomes).toEqual([{ ok: false, error: { code: "network" } }]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("answer after the deadline: dropped, never applied", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-09-30", ask); // a stale page
    today.start();
    await pass(TODAY_TIMEOUT_MS);
    expect(today.snapshot()).toEqual({ date: "2026-09-30", certain: false });

    pending[0]!({ ok: true, data: pg() });
    await pass(0);
    expect(today.snapshot()).toEqual({ date: "2026-09-30", certain: false });
  });

  it("retry sent before the old answer arrives: the old answer never replaces the retry's", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(TODAY_TIMEOUT_MS); // request 1 abandoned
    const old = pg(); // what request 1 will say: 1 Oct
    await pass(15 * MINUTE); // server: 2 Oct 00:05

    const retry = today.validate(); // request 2
    expect(ask).toHaveBeenCalledTimes(2);
    pending[0]!({ ok: true, data: old }); // the old answer comes first…
    await pass(0);
    expect(today.snapshot().certain).toBe(false);
    pending[1]!({ ok: true, data: pg() }); // …then the retry's
    expect(await retry).toEqual({ ok: true, data: "2026-10-02" });

    // …or the other way round.
    const again = today.validate(); // request 3
    pending[2]!({ ok: true, data: pg() });
    expect(await again).toEqual({ ok: true, data: "2026-10-02" });
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });
});

describe("life cycle", () => {
  it("stop leaves nothing behind: no timer, no listener, no pending request", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const result = today.validate();
    expect(vi.getTimerCount()).toBe(1); // the deadline

    today.stop();
    expect(await result).toEqual({ ok: false, error: { code: "network" } });
    expect(vi.getTimerCount()).toBe(0);
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(
      added.mock.calls.map(([type]) => type).sort(),
    );

    // Its answer changes nothing; nothing is asked any more.
    pending[0]!({ ok: true, data: { ...pg(), date: "2026-10-09" } });
    window.dispatchEvent(new Event("focus"));
    today.check();
    await pass(HOUR);
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await today.validate()).toEqual({
      ok: false,
      error: { code: "network" },
    });
    expect(vi.getTimerCount()).toBe(0);
    added.mockRestore();
    removed.mockRestore();
  });

  it("start → stop → start (Strict Mode): a silent request still ends at its deadline", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // request 1 (verification)
    today.stop(); // …cancelled with its deadline
    today.start(); // request 2, with its own deadline
    expect(ask).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    const result = today.validate(); // shares request 2
    expect(ask).toHaveBeenCalledTimes(2);
    await pass(TODAY_TIMEOUT_MS);
    expect(await result).toEqual({ ok: false, error: { code: "network" } });
    expect(vi.getTimerCount()).toBe(0);

    // The first cycle's answer is ignored; a retry works.
    pending[0]!({ ok: true, data: { ...pg(), date: "2026-10-09" } });
    const retry = today.validate();
    pending[2]!({ ok: true, data: pg() });
    expect(await retry).toEqual({ ok: true, data: "2026-10-01" });
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });
  });
});

describe("agenda reads", () => {
  it("another date in an agenda read is taken, then its end is asked", async () => {
    const ask = answering();
    const today = tracker("2026-10-01", ask);
    today.start();
    await pass(0);

    today.observe(today.begin(), { today: "2026-10-01" }); // nothing new
    expect(ask).toHaveBeenCalledTimes(1);

    server.ahead += 15 * MINUTE;
    today.observe(today.begin(), { today: "2026-10-02" });
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
    await pass(0);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("an answer asked before a newer agenda read never overrides it", async () => {
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // request 1, asked first
    const old = pg();
    server.ahead += 15 * MINUTE;
    today.observe(today.begin(), { today: "2026-10-02" });

    pending[0]!({ ok: true, data: old }); // says 1 Oct
    await pass(0);
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
    // The end of 2 Oct is then asked for.
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
