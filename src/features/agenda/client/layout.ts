import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDayDto,
} from "@/features/agenda/data/agenda";
import { addDaysToLocalDate } from "@/lib/time/zoned";

import { minutesOf } from "./dates";

// Places agenda items on a day column using the wall-clock values sent by the
// server. A local day is laid out as 00:00 → 24:00 on screen, but its real
// length (23 or 25 hours on DST days) is never assumed: positions come from
// the local times, and only when those collapse (02:30 → 02:30 during the
// repeated autumn hour) is the real duration used for the height.

const DAY_MINUTES = 24 * 60;
const MIN_HEIGHT = 15;

type Timed = {
  localStartsAt: string;
  localEndsAt: string;
  startsAt: string;
  endsAt: string;
};

export type Segment = {
  /** Minutes from local midnight. */
  top: number;
  height: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

const realMinutes = (item: Timed) =>
  Math.round((Date.parse(item.endsAt) - Date.parse(item.startsAt)) / 60_000);

/** Part of `item` shown on local `date`, or null when it does not touch it. */
export function segmentOn(item: Timed, date: string): Segment | null {
  const dayStart = `${date}T00:00`;
  const dayEnd = `${addDaysToLocalDate(date, 1)}T00:00`;
  const start = item.localStartsAt;
  const end = item.localEndsAt;

  if (start >= dayEnd) return null;
  // Equal bounds are a real period during the repeated hour, not empty.
  if (end <= dayStart && end !== start) return null;

  const continuesBefore = start < dayStart;
  const top = continuesBefore ? 0 : minutesOf(start);
  const bottom = end >= dayEnd ? DAY_MINUTES : minutesOf(end);
  let height = bottom - top;

  if (height <= 0) {
    // Local times collapsed by the autumn transition: use the real length.
    height = Math.min(realMinutes(item), DAY_MINUTES - top);
  }

  return {
    top,
    height: Math.max(height, MIN_HEIGHT),
    continuesBefore,
    continuesAfter: end > dayEnd,
  };
}

/** True when a block covers the whole local day (shown in the all-day row). */
export function coversWholeDay(block: Timed, date: string) {
  const dayStart = `${date}T00:00`;
  const dayEnd = `${addDaysToLocalDate(date, 1)}T00:00`;
  return block.localStartsAt <= dayStart && block.localEndsAt >= dayEnd;
}

/** A block made of whole local days (midnight to midnight). */
export function isAllDayBlock(
  block: Pick<Timed, "localStartsAt" | "localEndsAt">,
) {
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

/**
 * Appointments of one day with side-by-side lanes for overlapping ones
 * (only possible with cancelled appointments shown, or in data predating the
 * constraints).
 */
export function placeAppointments(
  appointments: AgendaAppointmentDto[],
  date: string,
): PlacedAppointment[] {
  const placed = appointments
    .map((appointment) => {
      const segment = segmentOn(appointment, date);
      return segment ? { ...segment, appointment, lane: 0, lanes: 1 } : null;
    })
    .filter((item): item is PlacedAppointment => item !== null)
    .sort((a, b) => a.top - b.top || b.height - a.height);

  let cluster: PlacedAppointment[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    const lanes = Math.max(1, ...cluster.map((item) => item.lane + 1));
    cluster.forEach((item) => (item.lanes = lanes));
    cluster = [];
  };

  for (const item of placed) {
    if (item.top >= clusterEnd) {
      closeCluster();
      clusterEnd = -1;
    }
    const taken = new Set(
      cluster
        .filter((other) => other.top + other.height > item.top)
        .map((other) => other.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    item.lane = lane;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.top + item.height);
  }
  closeCluster();

  return placed;
}

/** Timed blocks of one day (all-day coverage is shown separately). */
export function placeBlocks(
  blocks: AgendaBlockDto[],
  date: string,
): PlacedBlock[] {
  return blocks
    .filter((block) => !coversWholeDay(block, date))
    .map((block) => {
      const segment = segmentOn(block, date);
      return segment ? { ...segment, block } : null;
    })
    .filter((item): item is PlacedBlock => item !== null);
}

export function allDayBlocks(blocks: AgendaBlockDto[], date: string) {
  return blocks.filter((block) => coversWholeDay(block, date));
}

/** Opening ranges of one day as segments. */
export function openSegments(day: AgendaDayDto | undefined, date: string) {
  return (day?.openRanges ?? [])
    .map((range) => segmentOn(range, date))
    .filter((segment): segment is Segment => segment !== null);
}

/**
 * Hours the grid shows: at least 07:00–21:00, widened to every opening range
 * and every item of the visible days.
 */
export function visibleHours(
  days: string[],
  appointments: AgendaAppointmentDto[],
  blocks: AgendaBlockDto[],
  workingDays: AgendaDayDto[],
) {
  let first = 7 * 60;
  let last = 21 * 60;

  for (const date of days) {
    const segments = [
      ...placeAppointments(appointments, date),
      ...placeBlocks(blocks, date),
      ...openSegments(
        workingDays.find((day) => day.date === date),
        date,
      ),
    ];
    for (const segment of segments) {
      first = Math.min(first, segment.top);
      last = Math.max(last, segment.top + segment.height);
    }
  }

  return {
    startHour: Math.max(0, Math.floor(first / 60)),
    endHour: Math.min(24, Math.ceil(last / 60)),
  };
}
