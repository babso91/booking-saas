// Time zone helpers built on the IANA database shipped with the JS runtime.
// Never assume a default zone: every function takes the business zone.

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }

  return formatter;
}

export function isValidTimeZone(timeZone: string) {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function wallClockParts(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// Offset (local − UTC) in milliseconds at a given instant.
function offsetAt(instant: number, timeZone: string) {
  const p = wallClockParts(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );

  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Converts a wall-clock time `YYYY-MM-DDTHH:MM` in `timeZone` to a UTC instant.
 *
 * Both edge cases follow PostgreSQL's `timestamp AT TIME ZONE`, so the server
 * and the database always agree: an ambiguous time (autumn overlap) resolves
 * to the later instant (standard time) and a time inside the spring gap is
 * read with the offset in force before the transition.
 */
export function zonedLocalToUtc(localDateTime: string, timeZone: string): Date {
  const match = LOCAL_DATE_TIME.exec(localDateTime);

  if (!match) {
    throw new RangeError(`Invalid local date-time: ${localDateTime}`);
  }

  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);

  // Two offsets around the target cover both sides of a transition; the
  // latest instant whose wall clock matches wins.
  const candidates = [
    wallAsUtc - offsetAt(wallAsUtc - 86_400_000, timeZone),
    wallAsUtc - offsetAt(wallAsUtc + 86_400_000, timeZone),
  ].sort((a, b) => b - a);

  for (const candidate of candidates) {
    if (candidate + offsetAt(candidate, timeZone) === wallAsUtc) {
      return new Date(candidate);
    }
  }

  // Spring-forward gap: apply the offset in force before the transition.
  return new Date(wallAsUtc - offsetAt(wallAsUtc - 86_400_000, timeZone));
}

/** Formats a UTC instant as a local `YYYY-MM-DDTHH:MM` in `timeZone`. */
export function utcToZonedLocal(instant: Date | string, timeZone: string) {
  const p = wallClockParts(new Date(instant).getTime(), timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Calendar date `YYYY-MM-DD` of an instant in `timeZone`. */
export function zonedDateOf(instant: Date | string, timeZone: string) {
  return utcToZonedLocal(instant, timeZone).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Local calendar dates (`YYYY-MM-DD`, no time zone attached)
// ---------------------------------------------------------------------------

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function localDateAsUtcMidnight(localDate: string) {
  const match = LOCAL_DATE.exec(localDate);

  if (!match) {
    throw new RangeError(`Invalid local date: ${localDate}`);
  }

  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** `localDate` shifted by `days` calendar days (DST never matters here). */
export function addDaysToLocalDate(localDate: string, days: number) {
  return new Date(localDateAsUtcMidnight(localDate) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Calendar days from `from` to `to` (0 when equal, negative if `to` < `from`). */
export function daysBetweenLocalDates(from: string, to: string) {
  return Math.round(
    (localDateAsUtcMidnight(to) - localDateAsUtcMidnight(from)) / 86_400_000,
  );
}

/** 0 = Sunday … 6 = Saturday, as business_hours.weekday and `extract(dow)`. */
export function weekdayOfLocalDate(localDate: string) {
  return new Date(localDateAsUtcMidnight(localDate)).getUTCDay();
}

/**
 * UTC instant of a weekly-hours bound `HH:MM` on `localDate`, exactly as the
 * public availability engine reads it (private.compute_available_slots):
 * `00:00` is the real start of the day and `24:00` its real end
 * (startOfLocalDate, even where midnight repeats or is skipped); any other
 * time follows zonedLocalToUtc (PostgreSQL `AT TIME ZONE`).
 */
export function zonedTimeOnDateToUtc(
  localDate: string,
  time: string,
  timeZone: string,
) {
  if (time === "00:00") return startOfLocalDate(localDate, timeZone);
  if (time === "24:00") {
    return startOfLocalDate(addDaysToLocalDate(localDate, 1), timeZone);
  }
  return zonedLocalToUtc(`${localDate}T${time}`, timeZone);
}

/**
 * True when `YYYY-MM-DDTHH:MM` exists as written in `timeZone`, i.e. is not
 * skipped by a spring-forward transition (02:30 on the spring day in Paris).
 */
export function isExistingLocalTime(localDateTime: string, timeZone: string) {
  return (
    utcToZonedLocal(zonedLocalToUtc(localDateTime, timeZone), timeZone) ===
    localDateTime
  );
}

// ---------------------------------------------------------------------------
// Explicit resolution of a wall-clock time (no silent choice)
// ---------------------------------------------------------------------------

/** Which of the two instants of a repeated (autumn) local time is meant. */
export type LocalTimeOccurrence = "first" | "second";

export type ResolvedLocalTime =
  | { status: "exact"; instant: Date }
  /** Repeated hour: `first` is the earlier instant (before the transition). */
  | { status: "ambiguous"; first: Date; second: Date }
  /** Skipped by a spring-forward transition. */
  | { status: "nonexistent" };

/**
 * All instants whose wall clock in `timeZone` reads `YYYY-MM-DDTHH:MM`.
 * Unlike zonedLocalToUtc, which applies PostgreSQL's fixed rule, this never
 * picks an instant on the caller's behalf.
 */
export function resolveZonedLocal(
  localDateTime: string,
  timeZone: string,
): ResolvedLocalTime {
  const match = LOCAL_DATE_TIME.exec(localDateTime);

  if (!match) {
    throw new RangeError(`Invalid local date-time: ${localDateTime}`);
  }

  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const instants = [
    ...new Set(
      [
        wallAsUtc - offsetAt(wallAsUtc - 86_400_000, timeZone),
        wallAsUtc - offsetAt(wallAsUtc + 86_400_000, timeZone),
      ].filter(
        (candidate) => candidate + offsetAt(candidate, timeZone) === wallAsUtc,
      ),
    ),
  ].sort((a, b) => a - b);

  if (instants.length === 0) return { status: "nonexistent" };
  if (instants.length === 1) {
    return { status: "exact", instant: new Date(instants[0]!) };
  }
  return {
    status: "ambiguous",
    first: new Date(instants[0]!),
    second: new Date(instants[1]!),
  };
}

/**
 * `first` / `second` when the wall clock of `instant` is a repeated local
 * time, `null` otherwise. Minute precision, like the agenda.
 */
export function zonedOccurrenceOf(
  instant: Date | string,
  timeZone: string,
): LocalTimeOccurrence | null {
  const resolved = resolveZonedLocal(
    utcToZonedLocal(instant, timeZone),
    timeZone,
  );

  if (resolved.status !== "ambiguous") return null;

  const minute = Math.floor(new Date(instant).getTime() / 60_000);
  return minute === Math.floor(resolved.first.getTime() / 60_000)
    ? "first"
    : "second";
}

// ---------------------------------------------------------------------------
// Real bounds of a local calendar day
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/**
 * First real instant whose wall-clock date in `timeZone` is `localDate` or
 * later: where the local day `localDate` begins.
 *
 * Never the generic wall-clock → UTC rule (zonedLocalToUtc), which reads a
 * repeated time as its LATER occurrence:
 * - repeated midnight (America/Havana, 2026-11-01: 00:00 at 04:00Z and again
 *   at 05:00Z) → the FIRST occurrence;
 * - skipped midnight (Havana, 2027-03-14: 23:59 → 01:00), including a
 *   transition that starts before midnight → the first instant after the gap;
 * - a date that does not exist (Pacific/Apia, 2011-12-30) → the first instant
 *   of the next existing date, so that day is empty.
 *
 * Same definition and algorithm as the agenda UI
 * (src/features/agenda/client/layout.ts, localDayStart).
 */
export function startOfLocalDate(localDate: string, timeZone: string): Date {
  const midnight = resolveZonedLocal(`${localDate}T00:00`, timeZone);

  if (midnight.status === "exact") return midnight.instant;
  if (midnight.status === "ambiguous") return midnight.first;

  // Midnight skipped: first minute whose local date is ≥ localDate. UTC
  // offsets stay within ±14 h, so ±26 h brackets it; the local date only
  // moves forward across a gap, so the predicate is monotonic here.
  const utcMidnight = localDateAsUtcMidnight(localDate);
  let before = utcMidnight - 26 * 60 * MINUTE_MS;
  let after = utcMidnight + 26 * 60 * MINUTE_MS;

  while (after - before > MINUTE_MS) {
    const middle =
      before + Math.floor((after - before) / 2 / MINUTE_MS) * MINUTE_MS;
    if (zonedDateOf(new Date(middle), timeZone) >= localDate) after = middle;
    else before = middle;
  }

  return new Date(after);
}

/**
 * Real interval of whole local days `startDate`…`endDate` (inclusive):
 * [first instant of startDate, first instant of endDate + 1). Never assumes
 * 24-hour days (23 h, 25 h, 23.5 h, 26 h… follow from the zone's rules).
 */
export function localDateRangeToUtc(
  startDate: string,
  endDate: string,
  timeZone: string,
) {
  return {
    startsAt: startOfLocalDate(startDate, timeZone),
    endsAt: startOfLocalDate(addDaysToLocalDate(endDate, 1), timeZone),
  };
}

/**
 * UTC instant of a period bound typed as `YYYY-MM-DDTHH:MM`. Local midnight
 * is where the day begins (startOfLocalDate), whatever the zone does at
 * midnight; any other time follows zonedLocalToUtc.
 */
export function zonedBoundToUtc(localDateTime: string, timeZone: string) {
  return localDateTime.endsWith("T00:00")
    ? startOfLocalDate(localDateTime.slice(0, 10), timeZone)
    : zonedLocalToUtc(localDateTime, timeZone);
}
