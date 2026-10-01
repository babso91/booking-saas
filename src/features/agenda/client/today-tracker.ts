import type { UiResult } from "@/features/auth/client/call-action";
import type { BusinessTodayDto } from "@/lib/time/business-time";

import {
  anchored,
  msUntilEnd,
  retryDelay,
  unverified,
  type Clock,
  type KnownToday,
} from "./today";

/** Margin after the boundary before asking, so PostgreSQL has passed it too. */
const BOUNDARY_MARGIN_MS = 250;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Longest wait for an answer: an action never hangs on a silent request. */
export const TODAY_TIMEOUT_MS = 10_000;

const readClock = (): Clock => ({ mono: performance.now(), wall: Date.now() });
const unreachable: UiResult<string> = {
  ok: false,
  error: { code: "network" },
};

export type ShownToday = {
  /** Last date PostgreSQL called today. */
  date: string;
  /** False while that date may be over and no new answer came yet. */
  certain: boolean;
};

/** One question to PostgreSQL, with everything that guarantees it ends. */
type Flight = {
  promise: Promise<UiResult<string>>;
  /** Ends it now (stop): its answer, if any, will be ignored. */
  cancel: () => void;
};

/**
 * The business's date today on a screen that stays open (see ./today.ts).
 *
 * - `validate()` asks PostgreSQL and resolves with its date: every action
 *   that depends on today calls it first. The device clock never authorises
 *   an action.
 * - `snapshot()` is the display cache. It is verified on start, then asked
 *   again only when the date ends on the server — a timer for that moment,
 *   the tab coming back (timers do not run while a device sleeps), the
 *   screen's clock tick as a fallback (`check`). No polling: one request per
 *   day change. Agenda reads that show another date are taken into account
 *   (`begin` / `observe`).
 *
 * One request at a time, shared by every caller. A request always ends — by
 * its answer, by its deadline or by `stop` — and once ended it is dropped
 * for good: a late answer is never applied. `stop` leaves nothing behind (no
 * timer, no listener, no pending request), so start → stop → start (React
 * Strict Mode) behaves like a first start. Answers are applied in the order
 * they were asked. A failure keeps the last date, marked uncertain, and is
 * retried with a growing delay — never replaced by a local guess.
 */
export class TodayTracker {
  private known: KnownToday;
  private shown: ShownToday;
  private readonly listeners = new Set<() => void>();
  private sequence = { issued: 0, applied: 0 };
  private flight: Flight | null = null;
  private failure = { count: 0, retryAt: 0 };
  private boundary: number | null = null;
  private running = false;

  constructor(
    /** The date PostgreSQL gave with the page. */
    seed: string,
    private readonly ask: () => Promise<UiResult<BusinessTodayDto>>,
  ) {
    this.known = unverified(seed);
    this.shown = { date: seed, certain: true };
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = () => this.shown;

  private show(next: ShownToday) {
    if (next.date === this.shown.date && next.certain === this.shown.certain) {
      return;
    }
    this.shown = next;
    this.listeners.forEach((listener) => listener());
  }

  start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener("visibilitychange", this.onWake);
    window.addEventListener("focus", this.onWake);
    window.addEventListener("pageshow", this.onWake);
    this.schedule();
    this.check(); // verifies the page's date
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    document.removeEventListener("visibilitychange", this.onWake);
    window.removeEventListener("focus", this.onWake);
    window.removeEventListener("pageshow", this.onWake);
    this.stopBoundary();
    // Never a request left shared without its deadline.
    this.flight?.cancel();
  }

  // Timers do not run while a device sleeps and are throttled in background
  // tabs: look again whenever the screen comes back.
  private readonly onWake = () => {
    if (document.visibilityState !== "hidden") this.check();
  };

  private stopBoundary() {
    if (this.boundary !== null) window.clearTimeout(this.boundary);
    this.boundary = null;
  }

  /** A timer for the moment the known date ends on the server. */
  private schedule() {
    this.stopBoundary();
    const left = msUntilEnd(this.known, readClock());
    if (left === null || !this.running) return;
    this.boundary = window.setTimeout(
      this.check,
      Math.min(Math.max(left, 0) + BOUNDARY_MARGIN_MS, MAX_TIMEOUT_MS),
    );
  }

  /** Looks at the display cache and asks again when it is due. */
  readonly check = () => {
    if (!this.running) return;
    const left = msUntilEnd(this.known, readClock());
    if (left !== null && left > 0) return;
    if (left !== null) this.show({ ...this.shown, certain: false });
    // Nobody is looking: wait for the tab to come back.
    if (document.visibilityState === "hidden") return;
    if (performance.now() < this.failure.retryAt) return;
    void this.validate();
  };

  /** Asks PostgreSQL for today; concurrent callers share one request. */
  readonly validate = (): Promise<UiResult<string>> => {
    if (!this.running) return Promise.resolve(unreachable);
    if (this.flight) return this.flight.promise;

    const token = (this.sequence.issued += 1);
    const sent = readClock();
    let settle!: (result: UiResult<string>) => void;
    const promise = new Promise<UiResult<string>>((resolve) => {
      settle = resolve;
    });
    // The request ends exactly once, and always does: by its answer, by the
    // deadline or by `stop`.
    let over = false;
    const finish = (result: UiResult<string>) => {
      if (over) return;
      over = true;
      window.clearTimeout(deadline);
      if (this.flight?.promise === promise) this.flight = null;
      settle(result);
    };
    const failed = (result: UiResult<string>) => {
      const count = this.failure.count + 1;
      this.failure = { count, retryAt: performance.now() + retryDelay(count) };
      // Not verified, or already over on the server: nothing is shown as
      // today until PostgreSQL answers.
      const left = msUntilEnd(this.known, readClock());
      if (left === null || left <= 0) {
        this.show({ ...this.shown, certain: false });
      }
      finish(result);
    };

    const deadline = window.setTimeout(
      () => failed(unreachable),
      TODAY_TIMEOUT_MS,
    );
    this.flight = { promise, cancel: () => finish(unreachable) };

    void this.ask().then((result) => {
      // Past its deadline or stopped: dropped for good, even if it answers.
      if (over) return;
      if (!result.ok) return failed(result);

      this.failure = { count: 0, retryAt: 0 };
      if (token > this.sequence.applied) {
        this.sequence.applied = token;
        this.known = anchored(result.data, sent);
        this.show({ date: this.known.date, certain: true });
        this.schedule();
      }
      // A more recent answer (an agenda read) may already be in place…
      finish({ ok: true, data: this.known.date });
      // …and if that one came without its end, ask for it.
      if (this.known.remainingMs === null) void this.validate();
    });

    return promise;
  };

  /** Marks the start of an agenda read; pass the token to `observe`. */
  readonly begin = () => (this.sequence.issued += 1);

  /** An agenda read that shows another date: PostgreSQL moved on. */
  readonly observe = (token: number, data: { today: string }) => {
    if (!this.running) return;
    if (data.today === this.known.date) return;
    if (token <= this.sequence.applied) return;
    this.sequence.applied = token;
    this.known = unverified(data.today);
    this.stopBoundary();
    this.show({ date: data.today, certain: true });
    void this.validate(); // for the moment it ends
  };
}
