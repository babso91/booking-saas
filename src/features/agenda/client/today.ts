import type { AgendaDto } from "@/features/agenda/data/agenda";
import type { BusinessTodayDto } from "@/lib/time/business-time";

// "Today" of the business on a screen that stays open.
//
// PostgreSQL is the only authority for the business's date. The screen keeps
// the last date it sent together with the instant that date ends, and knows
// one thing by itself: whether that instant has passed. Once it has, the
// date is stale and PostgreSQL is asked again — the next date is never worked
// out here (no Intl, no time zone arithmetic, no "date + 1"). Only instants
// are compared.

export type KnownToday = {
  /** Civil date PostgreSQL called today. */
  date: string;
  /** Instant (ms) that date ends, or null when it was not sent. */
  endsAt: number | null;
  /** Device instant (ms) the answer was received; null for the page's value. */
  receivedAt: number | null;
};

/**
 * How long an answer whose end is already behind the device clock is still
 * trusted. Only happens when the device clock runs ahead of the server's:
 * the date is PostgreSQL's all the same, and it is asked again at most once
 * per window instead of in a loop.
 */
export const SKEW_TRUST_MS = 5 * 60_000;

export function knownFrom(
  today: BusinessTodayDto,
  receivedAt: number | null,
): KnownToday {
  return { date: today.date, endsAt: Date.parse(today.endsAt), receivedAt };
}

/** Instant (ms) until which `known` can be used without asking again. */
export function freshUntil(known: KnownToday): number {
  if (known.endsAt === null) return known.receivedAt ?? 0;
  if (known.receivedAt !== null && known.endsAt <= known.receivedAt) {
    return known.receivedAt + SKEW_TRUST_MS;
  }
  return known.endsAt;
}

export function isFresh(known: KnownToday, now: number) {
  return now < freshUntil(known);
}

/**
 * What an agenda read says about today: its date and, when that date is one
 * of the days read, the instant it ends. Null when it adds nothing to what
 * is already known (same date, no bounds).
 */
export function knownFromAgenda(
  data: Pick<AgendaDto, "today"> & {
    workingHours: { days: { date: string; endsAt: string }[] };
  },
  current: KnownToday,
  receivedAt: number,
): KnownToday | null {
  const day = data.workingHours.days.find((entry) => entry.date === data.today);
  if (day) {
    return { date: data.today, endsAt: Date.parse(day.endsAt), receivedAt };
  }
  if (data.today === current.date) return null;
  // The date changed but its end is unknown: stale at once, so its bounds
  // are asked for.
  return { date: data.today, endsAt: null, receivedAt };
}

/** Wait before asking again after `failures` failed attempts in a row. */
export function retryDelay(failures: number) {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 10 * 60_000);
}
