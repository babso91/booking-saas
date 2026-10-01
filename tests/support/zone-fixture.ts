import { zoneOf, type Zone } from "@/features/agenda/client/zone";
import type { ZoneOffsetDto } from "@/lib/time/business-time";
import {
  addDaysToLocalDate,
  startOfLocalDate,
  utcToZonedLocal,
} from "@/lib/time/zoned";

// What PostgreSQL (public.business_time) sends with an agenda, simulated
// with the test runtime's own time zone database. Tests only: production
// code never derives these values from Intl.

const HOUR = 3_600_000;

function offsetAt(instant: number, timeZone: string) {
  const local = utcToZonedLocal(new Date(instant), timeZone);
  const wall = Date.parse(`${local}:00Z`);
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/** Constant-offset pieces of [fromMs, toMs), like private.zone_offsets. */
export function intlOffsets(
  timeZone: string,
  fromMs: number,
  toMs: number,
): ZoneOffsetDto[] {
  const pieces: ZoneOffsetDto[] = [];
  let start = fromMs;
  let offset = offsetAt(fromMs, timeZone);
  let probe = fromMs;
  while (probe < toMs) {
    const next = Math.min(probe + HOUR, toMs);
    const check = next < toMs ? next : toMs - 60_000;
    if (check > probe && offsetAt(check, timeZone) !== offset) {
      let low = probe;
      let high = check;
      while (high - low > 60_000) {
        const middle = low + Math.floor((high - low) / 2 / 60_000) * 60_000;
        if (offsetAt(middle, timeZone) === offset) low = middle;
        else high = middle;
      }
      pieces.push({
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(high).toISOString(),
        offsetSeconds: offset / 1000,
      });
      start = high;
      offset = offsetAt(high, timeZone);
      probe = high;
    } else {
      probe = next;
    }
  }
  pieces.push({
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(toMs).toISOString(),
    offsetSeconds: offset / 1000,
  });
  return pieces;
}

/** Real bounds of a civil day (ms). */
export function intlDayBounds(date: string, timeZone: string) {
  return {
    startMs: startOfLocalDate(date, timeZone).getTime(),
    endMs: startOfLocalDate(addDaysToLocalDate(date, 1), timeZone).getTime(),
  };
}

/** Days and offsets of an agenda read, as the server would send them. */
export function intlCalendar(timeZone: string, dates: string[]) {
  const days = dates.map((date) => {
    const { startMs, endMs } = intlDayBounds(date, timeZone);
    return {
      date,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
    };
  });
  const from = Math.min(...days.map((day) => Date.parse(day.startsAt)));
  const to = Math.max(...days.map((day) => Date.parse(day.endsAt)));
  return { days, offsets: from < to ? intlOffsets(timeZone, from, to) : [] };
}

/** The UI zone for `dates`, as built from the server's answer. */
export function intlZone(timeZone: string, dates: string[]): Zone {
  const { days, offsets } = intlCalendar(timeZone, dates);
  return zoneOf({ timezone: timeZone, offsets, workingHours: { days } });
}
