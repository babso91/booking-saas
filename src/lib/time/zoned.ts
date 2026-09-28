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
