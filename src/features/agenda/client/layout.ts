import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDayDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import {
  addDaysToLocalDate,
  resolveZonedLocal,
  utcToZonedLocal,
} from "@/lib/time/zoned";

// Time grid model of the agenda, driven by real instants.
//
// Source of truth: the UTC instants of every item and the real bounds of
// each local day in the business time zone (localDayBounds, built on the
// IANA rules of the runtime through src/lib/time/zoned.ts). A local day is
// the half-open interval [first instant of the date, first instant of the
// next date) and may last any length (23, 24, 25 h, 23.5 h, 26 h…); an item
// is shown on a day if and only if its real period intersects that interval.
//
// Vertical axis ("y", in minutes): wall-clock time, aligned across the
// visible days. A fall-back transition inserts a band after the repeated
// wall-clock hour: on that day y is the real time elapsed since midnight, so
// the two occurrences of 02:30 sit at different heights; on the other days
// the band holds no time. A spring-forward day shows its skipped hour as a
// strip without time. Items are drawn in the real time they cover: an item
// crossing a strip without time is drawn in two pieces, so its drawn height
// always equals its real duration.

const DAY = 24 * 60;
const MINUTE = 60_000;
const MIN_PIECE = 15;

export type Interval = { top: number; bottom: number };

type Band = {
  /** Local date of the fall-back. */
  date: string;
  /** Repeated wall-clock interval [start, end) in minutes (e.g. 02:00–03:00). */
  start: number;
  end: number;
};

export type DayFrame = {
  date: string;
  startMs: number;
  endMs: number;
  /** y of the day's end (its last instant is just before). */
  endY: number;
  /** y intervals holding no time on this day. */
  gaps: Interval[];
  /** Skipped wall-clock interval of a spring-forward day. */
  skipped: Interval | null;
};

export type HourMark = { y: number; label: string; repeated: boolean };

export type Axis = {
  timeZone: string;
  band: Band | null;
  frames: Map<string, DayFrame>;
  marks: HourMark[];
};

const pad = (value: number) => String(value).padStart(2, "0");
const label = (minutes: number) =>
  `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

function localMs(instant: number, timeZone: string) {
  const local = utcToZonedLocal(new Date(instant), timeZone);
  return Date.UTC(
    Number(local.slice(0, 4)),
    Number(local.slice(5, 7)) - 1,
    Number(local.slice(8, 10)),
    Number(local.slice(11, 13)),
    Number(local.slice(14, 16)),
  );
}

/** UTC offset in minutes at an instant (minute precision). */
function offsetMinutes(instant: number, timeZone: string) {
  return Math.round(
    (localMs(instant, timeZone) - Math.floor(instant / MINUTE) * MINUTE) /
      MINUTE,
  );
}

/** Wall-clock minutes of `instant` on local `date` (the next midnight is 1440). */
function wallMinutes(instant: number, date: string, timeZone: string) {
  const local = utcToZonedLocal(new Date(instant), timeZone);
  if (local.slice(0, 10) !== date) return local.slice(0, 10) > date ? DAY : 0;
  return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
}

/** First instant (minute precision) after `from` whose offset differs from `from`'s. */
function transitionBetween(from: number, to: number, timeZone: string) {
  const initial = offsetMinutes(from, timeZone);
  if (offsetMinutes(to - MINUTE, timeZone) === initial) return null;
  let low = from;
  let high = to - MINUTE;
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
    if (offsetMinutes(middle, timeZone) === initial) low = middle;
    else high = middle;
  }
  return high;
}

const localDateOf = (instant: number, timeZone: string) =>
  utcToZonedLocal(new Date(instant), timeZone).slice(0, 10);

/**
 * First real instant (ms) whose wall-clock date in `timeZone` is `date`.
 *
 * Never the generic wall-clock → UTC rule, which picks one occurrence
 * arbitrarily: a repeated midnight (Havana, 1 Nov: 00:00 happens at 04:00Z
 * and again at 05:00Z) starts the day at its FIRST occurrence; a skipped
 * midnight (Havana, 8 Mar: 23:59 → 01:00) starts it at the transition. A
 * date that does not exist at all (Apia, 30 Dec 2011) yields the first
 * instant of the next date, i.e. an empty day.
 */
export function localDayStart(date: string, timeZone: string): number {
  const midnight = resolveZonedLocal(`${date}T00:00`, timeZone);
  if (midnight.status === "exact") return midnight.instant.getTime();
  if (midnight.status === "ambiguous") return midnight.first.getTime();

  // Skipped midnight: search the first minute whose local date is ≥ `date`.
  // UTC offsets stay within ±14 h, so these bounds bracket it.
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  let before = utcMidnight - 26 * 60 * MINUTE; // local date < date
  let after = utcMidnight + 26 * 60 * MINUTE; // local date ≥ date
  while (after - before > MINUTE) {
    const middle = before + Math.floor((after - before) / 2 / MINUTE) * MINUTE;
    if (localDateOf(middle, timeZone) >= date) after = middle;
    else before = middle;
  }
  return after;
}

/** Real bounds of a local day: [first instant of date, first instant of next date). */
export function localDayBounds(date: string, timeZone: string) {
  return {
    startMs: localDayStart(date, timeZone),
    endMs: localDayStart(addDaysToLocalDate(date, 1), timeZone),
  };
}

/**
 * Dates to request for the visible days. The backend reads a range from
 * local midnight with the PostgreSQL rule, which picks the SECOND occurrence
 * of a repeated midnight: the first real hour of such a day (Havana, 1 Nov
 * 04:00Z–05:00Z) would be missing. The previous day is requested as well and
 * the answer is trimmed back to the real bounds by `restrictToDays`.
 */
export function agendaRequestRange(days: string[]) {
  return {
    startDate: addDaysToLocalDate(days[0]!, -1),
    endDate: days[days.length - 1]!,
  };
}

/** The agenda restricted to the real interval of the visible days. */
export function restrictToDays(data: AgendaDto, days: string[]): AgendaDto {
  const timeZone = data.timezone;
  const startMs = localDayStart(days[0]!, timeZone);
  const endMs = localDayStart(
    addDaysToLocalDate(days[days.length - 1]!, 1),
    timeZone,
  );
  const inside = (item: Timed) =>
    Date.parse(item.startsAt) < endMs && Date.parse(item.endsAt) > startMs;
  return {
    ...data,
    appointments: data.appointments.filter(inside),
    blocks: data.blocks.filter(inside),
    workingHours: {
      ...data.workingHours,
      days: data.workingHours.days.filter((day) => days.includes(day.date)),
    },
  };
}

/** Builds the axis of the visible days (at most one fall-back per week). */
export function buildAxis(days: string[], timeZone: string): Axis {
  const bounds = days.map((date) => ({
    date,
    ...localDayBounds(date, timeZone),
  }));

  let band: Band | null = null;
  for (const { date, startMs, endMs } of bounds) {
    const length = Math.round((endMs - startMs) / MINUTE);
    if (length <= DAY) continue;
    const transition = transitionBetween(startMs, endMs, timeZone);
    if (transition === null) continue;
    const start = wallMinutes(transition, date, timeZone);
    band = { date, start, end: Math.min(start + (length - DAY), DAY) };
    break;
  }

  const shiftOf = (wall: number) =>
    band && band.end < DAY && wall >= band.end ? band.end - band.start : 0;
  const bandSize = band ? band.end - band.start : 0;

  const frames = new Map<string, DayFrame>();
  for (const { date, startMs, endMs } of bounds) {
    const length = Math.round((endMs - startMs) / MINUTE);
    const isBandDay = band?.date === date;
    const gaps: Interval[] = [];
    let skipped: Interval | null = null;

    if (length < DAY) {
      const size = DAY - length;
      const firstWall = wallMinutes(startMs, date, timeZone);
      const transition = transitionBetween(startMs, endMs, timeZone);
      // Where the skipped wall-clock time sits: at the start when midnight
      // itself is skipped (Havana 00:00 → 01:00), at the end when the jump
      // lands on the next midnight (Nuuk 23:00 → 00:00: the transition is
      // the day's end), otherwise just before the transition.
      const start =
        firstWall > 0
          ? 0
          : transition === null
            ? DAY - size
            : wallMinutes(transition, date, timeZone) - size;
      skipped = {
        top: start + shiftOf(start),
        bottom: start + size + shiftOf(start),
      };
      gaps.push(skipped);
    }
    if (band && !isBandDay) {
      gaps.push({
        top: band.end < DAY ? band.end : DAY,
        bottom: (band.end < DAY ? band.end : DAY) + bandSize,
      });
    }

    frames.set(date, {
      date,
      startMs,
      endMs,
      endY: isBandDay ? length : DAY + (band && band.end < DAY ? bandSize : 0),
      gaps,
      skipped,
    });
  }

  // Hour marks label the start of each row; the next midnight is the end of
  // the day, not a row, so it gets no mark (with a repeated hour at the very
  // end of a day, as in Cairo, it would share its y with "23:00 · 2e fois").
  const marks: HourMark[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    marks.push({
      y: hour * 60 + shiftOf(hour * 60),
      label: label(hour * 60),
      repeated: false,
    });
  }
  if (band) {
    for (let minute = band.start; minute < band.end; minute += 60) {
      marks.push({
        y: band.end + (minute - band.start),
        label: label(minute),
        repeated: true,
      });
    }
  }
  marks.sort((a, b) => a.y - b.y || Number(a.repeated) - Number(b.repeated));
  // Never two labels at the same place.
  const distinct = marks.filter(
    (mark, index) => index === 0 || marks[index - 1]!.y !== mark.y,
  );

  return { timeZone, band, frames, marks: distinct };
}

/** y of an instant inside the day `date` (clamped to the day). */
export function yOf(axis: Axis, date: string, instant: number): number {
  const frame = axis.frames.get(date);
  if (!frame) return 0;
  if (instant <= frame.startMs)
    return frame.gaps.find((gap) => gap.top === 0)?.bottom ?? 0;
  if (instant >= frame.endMs) return frame.endY;

  if (axis.band?.date === date) {
    // Fall-back day: y is the real time elapsed since local midnight.
    return Math.round((instant - frame.startMs) / MINUTE);
  }
  const wall = wallMinutes(instant, date, axis.timeZone);
  const band = axis.band;
  return (
    wall +
    (band && band.end < DAY && wall >= band.end ? band.end - band.start : 0)
  );
}

/** Wall-clock time shown at `y` on `date`, or null inside a strip without time. */
export function timeAt(axis: Axis, date: string, y: number): string | null {
  const frame = axis.frames.get(date);
  if (!frame || frame.gaps.some((gap) => y >= gap.top && y < gap.bottom))
    return null;
  if (axis.band?.date === date) {
    return utcToZonedLocal(
      new Date(frame.startMs + Math.max(0, y) * MINUTE),
      axis.timeZone,
    ).slice(11, 16);
  }
  const band = axis.band;
  const wall =
    band && band.end < DAY && y >= band.end + (band.end - band.start)
      ? y - (band.end - band.start)
      : y;
  return label(Math.max(0, Math.min(DAY - 1, Math.floor(wall))));
}

export type Segment = {
  /** Drawn pieces in y minutes; several when crossing a strip without time. */
  pieces: Interval[];
  top: number;
  bottom: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

type Timed = { startsAt: string; endsAt: string };

function subtractGaps(interval: Interval, gaps: Interval[]) {
  let pieces = [interval];
  for (const gap of gaps) {
    pieces = pieces.flatMap((piece) =>
      gap.bottom <= piece.top || gap.top >= piece.bottom
        ? [piece]
        : [
            ...(gap.top > piece.top
              ? [{ top: piece.top, bottom: gap.top }]
              : []),
            ...(gap.bottom < piece.bottom
              ? [{ top: gap.bottom, bottom: piece.bottom }]
              : []),
          ],
    );
  }
  return pieces;
}

/** Part of a real period shown on `date`, or null when they do not intersect. */
export function segmentOn(
  axis: Axis,
  item: Timed,
  date: string,
): Segment | null {
  const frame = axis.frames.get(date);
  if (!frame) return null;
  const start = Date.parse(item.startsAt);
  const end = Date.parse(item.endsAt);
  const from = Math.max(start, frame.startMs);
  const to = Math.min(end, frame.endMs);
  if (from >= to) return null;

  const top = yOf(axis, date, from);
  const bottom = Math.max(yOf(axis, date, to), top + MIN_PIECE);
  const pieces = subtractGaps({ top, bottom }, frame.gaps);
  if (pieces.length === 0) return null;

  return {
    pieces,
    top: pieces[0]!.top,
    bottom: pieces[pieces.length - 1]!.bottom,
    continuesBefore: start < frame.startMs,
    continuesAfter: end > frame.endMs,
  };
}

/** A block covering the whole local day, whatever its length. */
export function coversWholeDay(axis: Axis, block: Timed, date: string) {
  const frame = axis.frames.get(date);
  return (
    !!frame &&
    Date.parse(block.startsAt) <= frame.startMs &&
    Date.parse(block.endsAt) >= frame.endMs
  );
}

/** Midnight-to-midnight block, as the block form edits it (whole days). */
export function isAllDayBlock(block: {
  localStartsAt: string;
  localEndsAt: string;
}) {
  return (
    block.localStartsAt.endsWith("T00:00") &&
    block.localEndsAt.endsWith("T00:00") &&
    block.localEndsAt.slice(0, 10) > block.localStartsAt.slice(0, 10)
  );
}

export type PlacedAppointment = Segment & {
  appointment: AgendaAppointmentDto;
  lane: number;
  lanes: number;
};

export type PlacedBlock = Segment & { block: AgendaBlockDto };

/** Appointments of one day, side by side when they overlap. */
export function placeAppointments(
  axis: Axis,
  appointments: AgendaAppointmentDto[],
  date: string,
): PlacedAppointment[] {
  const placed = appointments
    .map((appointment) => {
      const segment = segmentOn(axis, appointment, date);
      return segment ? { ...segment, appointment, lane: 0, lanes: 1 } : null;
    })
    .filter((item): item is PlacedAppointment => item !== null)
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  let cluster: PlacedAppointment[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((item) => item.lane + 1));
    cluster.forEach((item) => (item.lanes = lanes));
    cluster = [];
  };

  for (const item of placed) {
    if (item.top >= clusterEnd) {
      close();
      clusterEnd = -Infinity;
    }
    const taken = new Set(
      cluster
        .filter((other) => other.bottom > item.top)
        .map((other) => other.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    item.lane = lane;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.bottom);
  }
  close();

  return placed;
}

/** Timed blocks of one day (whole-day coverage is shown in the all-day row). */
export function placeBlocks(
  axis: Axis,
  blocks: AgendaBlockDto[],
  date: string,
): PlacedBlock[] {
  return blocks
    .filter((block) => !coversWholeDay(axis, block, date))
    .map((block) => {
      const segment = segmentOn(axis, block, date);
      return segment ? { ...segment, block } : null;
    })
    .filter((item): item is PlacedBlock => item !== null);
}

export function allDayBlocks(
  axis: Axis,
  blocks: AgendaBlockDto[],
  date: string,
) {
  return blocks.filter((block) => coversWholeDay(axis, block, date));
}

/** Opening ranges of a day, from their real instants. */
export function openSegments(
  axis: Axis,
  day: AgendaDayDto | undefined,
  date: string,
) {
  return (day?.openRanges ?? [])
    .map((range) => segmentOn(axis, range, date))
    .filter((segment): segment is Segment => segment !== null);
}

/**
 * y window shown by the grid: at least 07:00–21:00, widened to the opening
 * ranges and items of the visible days, snapped to hour marks.
 */
export function visibleWindow(
  axis: Axis,
  days: string[],
  appointments: AgendaAppointmentDto[],
  blocks: AgendaBlockDto[],
  workingDays: AgendaDayDto[],
) {
  const markAt = (hour: number) =>
    axis.marks.find(
      (mark) => !mark.repeated && mark.label === label(hour * 60),
    )!.y;
  let first = markAt(7);
  let last = markAt(21);

  for (const date of days) {
    const segments = [
      ...placeAppointments(axis, appointments, date),
      ...placeBlocks(axis, blocks, date),
      ...openSegments(
        axis,
        workingDays.find((day) => day.date === date),
        date,
      ),
    ];
    for (const segment of segments) {
      first = Math.min(first, segment.top);
      last = Math.max(last, segment.bottom);
    }
  }

  const ys = axis.marks.map((mark) => mark.y);
  const maxY = Math.max(
    ...days.map((date) => axis.frames.get(date)?.endY ?? DAY),
    ...ys,
  );
  return {
    startY: Math.max(0, Math.max(...ys.filter((y) => y <= first))),
    endY: Math.min(maxY, Math.min(...ys.filter((y) => y >= last), maxY)),
  };
}
