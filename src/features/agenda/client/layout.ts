import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDayDto,
} from "@/features/agenda/data/agenda";
import {
  addDaysToLocalDate,
  utcToZonedLocal,
  zonedLocalToUtc,
} from "@/lib/time/zoned";

// Time grid model of the agenda, driven by real instants.
//
// Source of truth: the UTC instants of every item and the UTC instants of
// each local midnight in the business time zone (the same central helpers as
// the server, src/lib/time/zoned.ts). A local day is [dayStart, dayEnd) and
// lasts 23, 24 or 25 hours; an item is shown on a day only when its real
// period intersects that interval.
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

/** Builds the axis of the visible days (at most one fall-back per week). */
export function buildAxis(days: string[], timeZone: string): Axis {
  const bounds = days.map((date) => ({
    date,
    startMs: zonedLocalToUtc(`${date}T00:00`, timeZone).getTime(),
    endMs: zonedLocalToUtc(
      `${addDaysToLocalDate(date, 1)}T00:00`,
      timeZone,
    ).getTime(),
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
      const start =
        firstWall > 0 || transition === null
          ? 0
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

  const marks: HourMark[] = [];
  for (let hour = 0; hour <= 24; hour += 1) {
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
  marks.sort((a, b) => a.y - b.y);

  return { timeZone, band, frames, marks };
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
