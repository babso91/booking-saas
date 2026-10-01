import type { BusinessTodayDto } from "@/lib/time/business-time";

// "Today" of the business on a screen that stays open.
//
// PostgreSQL is the only authority for the business's date, and the device
// clock cannot certify anything about it: it may be minutes or hours off.
//
// - An ACTION that depends on today (the Aujourd’hui button, the default day
//   of a creation) asks PostgreSQL every time, right before acting. Nothing
//   kept here ever authorises it.
// - What is kept here is a DISPLAY cache (today's highlight, the "now"
//   line). It is timed from the server's own clock: the answer says how long
//   the date still lasts on the server (`endsAt − now`), and the screen only
//   measures how much time has ELAPSED since it asked. The device's wall
//   clock is never compared with a server instant, so a wrong clock or a
//   wrong time zone cannot keep a stale date alive or invent the next one.
//
// The next date is never worked out here (no Intl, no "date + 1").

/** Two readings of the device, used for durations only. */
export type Clock = {
  /** Monotonic (performance.now): immune to clock changes, may pause in sleep. */
  mono: number;
  /** Wall (Date.now): keeps running in sleep, may be changed by hand. */
  wall: number;
};

export type KnownToday = {
  /** Civil date PostgreSQL called today. */
  date: string;
  /**
   * How long that date still lasted on the server when it answered, or null
   * when the date is known without its end (the page's value, a date seen in
   * an agenda read): it is then verified as soon as possible.
   */
  remainingMs: number | null;
  /** Device readings when the question was SENT (so latency counts as elapsed). */
  sent: Clock;
};

/**
 * Shortest life given to an answer. The server's clock (which timestamps
 * `now`) and PostgreSQL's (which decides the date) can differ by a moment
 * around midnight: without a floor the screen would ask again in a loop.
 * Display only — actions never rely on it.
 */
export const MIN_REMAINING_MS = 5_000;

export function unverified(date: string): KnownToday {
  return { date, remainingMs: null, sent: { mono: 0, wall: 0 } };
}

export function anchored(today: BusinessTodayDto, sent: Clock): KnownToday {
  return {
    date: today.date,
    remainingMs: Math.max(
      Date.parse(today.endsAt) - Date.parse(today.now),
      MIN_REMAINING_MS,
    ),
    sent,
  };
}

/**
 * Time elapsed since the question was sent: the larger of the two readings,
 * so neither a sleep (monotonic clock paused) nor a clock set back by hand
 * can hide that time has passed. Too large only asks again early.
 */
export function elapsedSince(sent: Clock, clock: Clock) {
  return Math.max(clock.mono - sent.mono, clock.wall - sent.wall);
}

/** Time left before the known date ends on the server; null when unverified. */
export function msUntilEnd(known: KnownToday, clock: Clock): number | null {
  if (known.remainingMs === null) return null;
  return known.remainingMs - elapsedSince(known.sent, clock);
}

/** Wait before asking again after `failures` failed attempts in a row. */
export function retryDelay(failures: number) {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 10 * 60_000);
}
