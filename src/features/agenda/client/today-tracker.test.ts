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
/**
 * A transport that holds every answer. Each answer is PostgreSQL's snapshot
 * taken when the request STARTED (`snapshots`), delivered when the test says
 * so (`deliver`): a request sent before midnight says "yesterday" even if it
 * is delivered after midnight.
 */
function asking() {
  const pending: ((answer: Answer) => void)[] = [];
  const snapshots: BusinessTodayDto[] = [];
  const ask = vi.fn(() => {
    snapshots.push(pg());
    return new Promise<Answer>((resolve) => pending.push(resolve));
  });
  const deliver = (index: number) =>
    pending[index]!({ ok: true, data: snapshots[index]! });
  return { ask, pending, snapshots, deliver };
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
    ["24 hours late", -24 * HOUR],
    ["24 hours ahead", 24 * HOUR],
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

  it("every action sends its own question; nothing is shared between actions", async () => {
    const { ask, deliver } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // display read 0
    const first = today.validate(); // 1
    const second = today.validate(); // 2
    expect(ask).toHaveBeenCalledTimes(3);

    deliver(2);
    expect(await second).toEqual({ ok: true, data: "2026-10-01" });
    let settled = false;
    void first.then(() => (settled = true));
    await pass(0);
    expect(settled).toBe(false); // another action's answer is not its answer
    deliver(1);
    expect(await first).toEqual({ ok: true, data: "2026-10-01" });
  });
});

describe("display reads and action reads are never mixed", () => {
  it("timer, focus, visibility and ticks share ONE display read", async () => {
    const { ask } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    for (let tick = 0; tick < 5; tick += 1) today.check();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  // Codex's reproduction. A: a display read sent at 21:59:59Z (1 Oct in
  // Paris), held in the transport. The user acts at 22:00:02Z (2 Oct).
  async function pendingDisplayReadThenAction() {
    server.now = at("2026-10-01T21:59:59Z");
    const transport = asking();
    const today = tracker("2026-10-01", transport.ask);
    today.start(); // A
    expect(transport.snapshots[0]!.date).toBe("2026-10-01");

    await pass(3_000); // 22:00:02Z
    const action = today.validate(); // B, sent after the intention
    expect(transport.ask).toHaveBeenCalledTimes(2);
    expect(transport.snapshots[1]!.date).toBe("2026-10-02");
    let outcome: unknown = "pending";
    void action.then((value) => (outcome = value));
    await pass(3_000); // 22:00:05Z
    return { ...transport, today, action, outcome: () => outcome };
  }

  it("a read started before the action never satisfies it (A delivered first, then B)", async () => {
    const { deliver, today, action, outcome } =
      await pendingDisplayReadThenAction();

    deliver(0); // A: "1 Oct", delivered after midnight
    await pass(0);
    expect(outcome()).toBe("pending");

    deliver(1); // B
    expect(await action).toEqual({ ok: true, data: "2026-10-02" });
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });

  it("B delivered first, then A: the old read never brings the cache back to 1 Oct", async () => {
    const { deliver, today, action } = await pendingDisplayReadThenAction();

    deliver(1); // B
    expect(await action).toEqual({ ok: true, data: "2026-10-02" });
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });

    deliver(0); // A, at last
    await pass(MINUTE);
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });

  it("an action just before midnight uses ITS read, whenever it is delivered", async () => {
    server.now = at("2026-10-01T21:59:59.500Z");
    const { ask, deliver, snapshots } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const action = today.validate(); // sent at 21:59:59.5: PostgreSQL says 1 Oct
    expect(snapshots[1]!.date).toBe("2026-10-01");

    await pass(4_000); // delivered after midnight
    deliver(1);
    // The read was made for this intention: its date is the answer.
    expect(await action).toEqual({ ok: true, data: "2026-10-01" });
  });

  it("an action answered after a later read was applied gets that later date, never an earlier one", async () => {
    server.now = at("2026-10-01T21:59:59.500Z");
    const { ask, deliver, snapshots } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // 0
    const early = today.validate(); // 1: sent before midnight → 1 Oct
    await pass(2_000);
    const late = today.validate(); // 2: sent after midnight → 2 Oct
    expect(snapshots.map((snapshot) => snapshot.date)).toEqual([
      "2026-10-01",
      "2026-10-01",
      "2026-10-02",
    ]);

    deliver(2);
    expect(await late).toEqual({ ok: true, data: "2026-10-02" });
    deliver(1); // its own snapshot says 1 Oct, but a later read is known
    expect(await early).toEqual({ ok: true, data: "2026-10-02" });
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });

  it("an action that never answers is not satisfied by a display answer; only its retry runs", async () => {
    const { ask, deliver, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // A (display)
    const action = today.validate(); // B
    let outcome: unknown = "pending";
    void action.then((value) => (outcome = value));

    await pass(5_000);
    deliver(0); // A answers meanwhile
    await pass(0);
    expect(outcome).toBe("pending");
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });

    await pass(TODAY_TIMEOUT_MS - 5_000);
    expect(outcome).toEqual({ ok: false, error: { code: "network" } });

    await pass(15 * MINUTE); // 2 Oct now
    const retry = today.validate(); // C
    const asked = ask.mock.calls.length;
    let retried: unknown = "pending";
    void retry.then((value) => (retried = value));
    deliver(1); // B answers at last, with its old snapshot
    await pass(0);
    expect(retried).toBe("pending");
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: false });

    pending[asked - 1]!({ ok: true, data: pg() }); // C
    expect(await retry).toEqual({ ok: true, data: "2026-10-02" });
    expect(today.snapshot()).toEqual({ date: "2026-10-02", certain: true });
  });
});

describe("a read always ends, and an ended read never comes back", () => {
  it("never answers: network error at the deadline, then a retry works", async () => {
    const { ask, deliver } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // 0 (display)
    const result = today.validate(); // 1
    let settled = false;
    void result.then(() => (settled = true));

    await pass(TODAY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await pass(1);
    expect(await result).toEqual({ ok: false, error: { code: "network" } });
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: false });

    const retry = today.validate(); // 2
    expect(ask).toHaveBeenCalledTimes(3);
    deliver(2);
    expect(await retry).toEqual({ ok: true, data: "2026-10-01" });
    expect(today.snapshot().certain).toBe(true);
  });

  it("answer just before the deadline: applied", async () => {
    const { ask, deliver } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const result = today.validate(); // 1
    await pass(TODAY_TIMEOUT_MS - 1);
    deliver(1);
    expect(await result).toEqual({ ok: true, data: "2026-10-01" });
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });
  });

  it("answer in the same instant as the deadline: one outcome only, whichever came first", async () => {
    const { ask, deliver } = asking();
    const today = tracker("2026-10-01", ask);
    today.start();
    const result = today.validate(); // 1
    const outcomes: unknown[] = [];
    void result.then((value) => outcomes.push(value));
    await pass(TODAY_TIMEOUT_MS); // the deadline fires first…
    deliver(1); // …the answer right behind
    await pass(0);
    expect(outcomes).toEqual([{ ok: false, error: { code: "network" } }]);
  });

  it("answer after the deadline: dropped, never applied", async () => {
    const { ask, deliver } = asking();
    const today = tracker("2026-09-30", ask); // a stale page
    today.start();
    await pass(TODAY_TIMEOUT_MS);
    expect(today.snapshot()).toEqual({ date: "2026-09-30", certain: false });

    deliver(0);
    await pass(0);
    expect(today.snapshot()).toEqual({ date: "2026-09-30", certain: false });
  });
});

describe("life cycle", () => {
  it("stop leaves nothing behind: no timer, no listener, no pending read of either kind", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { ask, pending } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // display read
    const result = today.validate(); // action read
    expect(vi.getTimerCount()).toBe(2); // their two deadlines

    today.stop();
    expect(await result).toEqual({ ok: false, error: { code: "network" } });
    expect(vi.getTimerCount()).toBe(0);
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(
      added.mock.calls.map(([type]) => type).sort(),
    );

    // Their answers change nothing; nothing is asked any more.
    pending[0]!({ ok: true, data: { ...pg(), date: "2026-10-09" } });
    pending[1]!({ ok: true, data: { ...pg(), date: "2026-10-09" } });
    window.dispatchEvent(new Event("focus"));
    today.check();
    await pass(HOUR);
    expect(today.snapshot()).toEqual({ date: "2026-10-01", certain: true });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(await today.validate()).toEqual({
      ok: false,
      error: { code: "network" },
    });
    expect(vi.getTimerCount()).toBe(0);
    added.mockRestore();
    removed.mockRestore();
  });

  it("start → stop → start (Strict Mode): like a first start, and a silent action still ends at its deadline", async () => {
    const { ask, pending, deliver } = asking();
    const today = tracker("2026-10-01", ask);
    today.start(); // read 0 (verification)
    today.stop(); // …cancelled with its deadline, not counted as a failure
    today.start(); // read 1, at once, with its own deadline
    expect(ask).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    const result = today.validate(); // read 2, with its own deadline
    expect(vi.getTimerCount()).toBe(2);
    await pass(TODAY_TIMEOUT_MS);
    expect(await result).toEqual({ ok: false, error: { code: "network" } });
    expect(vi.getTimerCount()).toBe(0);

    // The first cycle's answer is ignored; a retry works.
    pending[0]!({ ok: true, data: { ...pg(), date: "2026-10-09" } });
    const retry = today.validate(); // read 3
    deliver(3);
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
