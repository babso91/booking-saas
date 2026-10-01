import type { AgendaDayDto, AgendaDto } from "@/features/agenda/data/agenda";

// The business time zone as the agenda UI knows it: exactly what PostgreSQL
// (the calendar authority) sent with the agenda — the real bounds of each
// day read and the UTC offset pieces covering them. Every placement on the
// grid is plain arithmetic on these values; the browser's own time zone
// database (Intl) is never consulted, so the grid cannot disagree with the
// public availability or the booking, whatever tzdata the browser ships.

type Piece = { start: number; end: number; offsetMs: number };

export type Zone = {
  timeZone: string;
  /** Constant-offset pieces, in order (ms). */
  pieces: Piece[];
  /** Real bounds of each civil day read: [startMs, endMs). */
  days: Map<string, { startMs: number; endMs: number }>;
};

export function zoneOf(
  data: Pick<AgendaDto, "timezone" | "offsets"> & {
    workingHours: {
      days: Pick<AgendaDayDto, "date" | "startsAt" | "endsAt">[];
    };
  },
): Zone {
  return {
    timeZone: data.timezone,
    pieces: data.offsets
      .map((piece) => ({
        start: Date.parse(piece.startsAt),
        end: Date.parse(piece.endsAt),
        offsetMs: piece.offsetSeconds * 1000,
      }))
      .sort((a, b) => a.start - b.start),
    days: new Map(
      data.workingHours.days.map((day) => [
        day.date,
        { startMs: Date.parse(day.startsAt), endMs: Date.parse(day.endsAt) },
      ]),
    ),
  };
}

function pieceAt(zone: Zone, instant: number) {
  return zone.pieces.find(
    (piece) => instant >= piece.start && instant < piece.end,
  );
}

/** UTC offset (ms) at an instant, or null outside the days read. */
export function offsetAt(zone: Zone, instant: number): number | null {
  return pieceAt(zone, instant)?.offsetMs ?? null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Wall clock `YYYY-MM-DDTHH:MM` of an instant, or null outside the days read
 * (never a guess with the browser's rules).
 */
export function wallOf(zone: Zone, instant: number): string | null {
  const offset = offsetAt(zone, instant);
  if (offset === null) return null;
  const wall = new Date(Math.floor((instant + offset) / 60_000) * 60_000);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}

/** Real bounds of a civil day read, or undefined. */
export function dayBounds(zone: Zone, date: string) {
  return zone.days.get(date);
}

/** The civil day read that contains `instant`, or null. */
export function dateContaining(zone: Zone, instant: number): string | null {
  for (const [date, { startMs, endMs }] of zone.days) {
    if (instant >= startMs && instant < endMs) return date;
  }
  return null;
}

/** First instant in (from, to) where the offset changes, or null. */
export function transitionWithin(
  zone: Zone,
  from: number,
  to: number,
): number | null {
  for (let index = 1; index < zone.pieces.length; index += 1) {
    const previous = zone.pieces[index - 1]!;
    const piece = zone.pieces[index]!;
    if (
      piece.start > from &&
      piece.start < to &&
      previous.end === piece.start &&
      previous.offsetMs !== piece.offsetMs
    ) {
      return piece.start;
    }
  }
  return null;
}

const formatOffset = (offsetMs: number) => {
  const minutes = Math.round(offsetMs / 60_000);
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `UTC${sign}${hours}${rest ? `:${pad(rest)}` : ""}`;
};

/**
 * Offsets in force at the start and at the end of a civil day read
 * ("UTC+2" / "UTC+1" on the autumn day in Paris), or null when the day was
 * not read.
 */
export function dayOffsets(zone: Zone | null, date: string) {
  const bounds = zone && dayBounds(zone, date);
  if (!zone || !bounds || bounds.endMs <= bounds.startMs) return null;
  const before = offsetAt(zone, bounds.startMs);
  const after = offsetAt(zone, bounds.endMs - 1);
  if (before === null || after === null) return null;
  return { before: formatOffset(before), after: formatOffset(after) };
}
