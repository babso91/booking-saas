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
 * Two kinds of read, never mixed:
 *
 * - ACTION read — `validate()`. Every call sends its OWN question to
 *   PostgreSQL, after the user's intention, and resolves with the date of
 *   THAT answer (or of a read sent even later, if one was applied
 *   meanwhile). It never joins a request already in flight (a read started
 *   before the click says nothing about the date at the click), not even
 *   another action's. The device clock never authorises an action.
 * - DISPLAY read — the cache behind `snapshot()` (highlight, "now" line).
 *   Verified on start, then asked again only when the date ends on the
 *   server — a timer for that moment, the tab coming back (timers do not run
 *   while a device sleeps), the screen's clock tick as a fallback (`check`).
 *   These triggers share one display request. No polling: one request per
 *   day change. Agenda reads that show another date are taken into account
 *   (`begin` / `observe`).
 *
 * Whatever its kind, a read always ends — by its answer, by its deadline or
 * by `stop` — and once ended it is dropped for good: a late answer is never
 * applied. Every answer also refreshes the display cache, in the order the
 * questions were SENT: an older read never overrides a newer one. `stop`
 * leaves nothing behind (no timer, no listener, no pending read), so
 * start → stop → start (React Strict Mode) behaves like a first start. A
 * failed display read keeps the last date, marked uncertain, and is retried
 * with a growing delay — never replaced by a local guess.
 */
export class TodayTracker {
  private known: KnownToday;
  private shown: ShownToday;
  private readonly listeners = new Set<() => void>();
  private sequence = { issued: 0, applied: 0 };
  /** Every read in flight, of both kinds: all end with `stop`. */
  private readonly flights = new Set<Flight>();
  /** The display read in flight, shared by the display triggers only. */
  private display: Flight | null = null;
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
    // Never a read left pending without its deadline.
    [...this.flights].forEach((flight) => flight.cancel());
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
    void this.refreshDisplay();
  };

  /**
   * ACTION read: a question sent now, for this call only. Resolves with the
   * date of its own answer.
   */
  readonly validate = (): Promise<UiResult<string>> => this.read().promise;

  /** DISPLAY read: timer, wake-up and tick share the one in flight. */
  private refreshDisplay() {
    if (!this.running || this.display) return;
    this.display = this.read((outcome) => {
      this.display = null;
      // A read cancelled by `stop` did not fail: no delay for the next start.
      if (outcome !== "failed") return;
      const count = this.failure.count + 1;
      this.failure = { count, retryAt: performance.now() + retryDelay(count) };
    });
  }

  /** Sends one question; `ended` is told how it went, exactly once. */
  private read(
    ended?: (outcome: "answered" | "failed" | "cancelled") => void,
  ): Flight {
    if (!this.running) {
      return { promise: Promise.resolve(unreachable), cancel: () => {} };
    }

    const token = (this.sequence.issued += 1);
    const sent = readClock();
    let settle!: (result: UiResult<string>) => void;
    const promise = new Promise<UiResult<string>>((resolve) => {
      settle = resolve;
    });
    // The read ends exactly once, and always does: by its answer, by the
    // deadline or by `stop`.
    let over = false;
    const finish = (
      result: UiResult<string>,
      outcome: "answered" | "failed" | "cancelled",
    ) => {
      if (over) return;
      over = true;
      window.clearTimeout(deadline);
      this.flights.delete(flight);
      ended?.(outcome);
      settle(result);
    };
    const failed = (result: UiResult<string>) => {
      // Not verified, or already over on the server: nothing is shown as
      // today until PostgreSQL answers.
      const left = msUntilEnd(this.known, readClock());
      if (left === null || left <= 0) {
        this.show({ ...this.shown, certain: false });
      }
      finish(result, "failed");
    };

    const deadline = window.setTimeout(
      () => failed(unreachable),
      TODAY_TIMEOUT_MS,
    );
    const flight: Flight = {
      promise,
      cancel: () => finish(unreachable, "cancelled"),
    };
    this.flights.add(flight);

    void this.ask().then((result) => {
      // Past its deadline or stopped: dropped for good, even if it answers.
      if (over) return;
      if (!result.ok) return failed(result);

      // The display cache follows the most recently SENT read.
      if (token > this.sequence.applied) {
        this.sequence.applied = token;
        this.failure = { count: 0, retryAt: 0 };
        this.known = anchored(result.data, sent);
        this.show({ date: this.known.date, certain: true });
        this.schedule();
      }
      // The caller gets the date of its own read — or, if a read SENT AFTER
      // it has already been applied, that more recent date. Either way a
      // read started after the caller's intention, never one before it.
      finish({ ok: true, data: this.known.date }, "answered");
      // A newer agenda read may have left the cache without its end.
      if (this.known.remainingMs === null) this.refreshDisplay();
    });

    return flight;
  }

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
    this.refreshDisplay(); // for the moment it ends
  };
}
