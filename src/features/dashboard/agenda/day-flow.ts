import { wallOf, zoneOf, type Zone } from "@/features/agenda/client/zone";
import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";

// The Studio day, as a chronological flow rather than a scale drawing: her
// visits in order (taller when longer), visits that overlap side by side,
// her pauses and closures where they fall, the free time between them
// (offered for a new appointment when it is still ahead), and "now".
//
// Pure, from the agenda read for that day: PostgreSQL's day bounds and
// offsets (zone), real instants compared as instants. Nothing is invented:
// a slot's state is its time and her own statuses, never a guess.

const MINUTE = 60_000;
/** Free time shorter than this is not offered (nor shown). */
export const MIN_FREE_MINUTES = 15;

export type VisitTiming = "past" | "now" | "ahead";

export type FlowVisit = {
  appointment: AgendaAppointmentDto;
  start: number;
  end: number;
  timing: VisitTiming;
  /** Part of it lies on the day before / after (across midnight). */
  startsBefore: boolean;
  endsAfter: boolean;
};

export type FlowItem =
  /** One visit, or several that overlap (shown side by side). */
  | { kind: "visits"; start: number; end: number; visits: FlowVisit[] }
  | {
      kind: "block";
      start: number;
      end: number;
      block: AgendaBlockDto;
      startsBefore: boolean;
      endsAfter: boolean;
    }
  | {
      kind: "free";
      start: number;
      end: number;
      minutes: number;
      /** `HH:MM` of its start, her wall clock (to create there). */
      time: string;
      /** Still ahead: she can book it. */
      bookable: boolean;
    }
  | { kind: "now"; start: number; end: number; time: string };

export type DayFlow = {
  date: string;
  /** Real bounds of the day (ms). */
  bounds: { start: number; end: number };
  items: FlowItem[];
  /** The next visit still to start (today only), not cancelled. */
  next: FlowVisit | null;
  /** Visits shown that day (overlapping it), cancelled ones included if read. */
  count: number;
  /** No opening that day, or her "closed" exceptions cover all of it. */
  closed: boolean;
};

type Interval = { start: number; end: number };

const live = (appointment: AgendaAppointmentDto) =>
  appointment.status !== "cancelled";

function union(intervals: Interval[]) {
  const merged: Interval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** `a` minus `b`, both unions. */
function subtract(a: Interval[], b: Interval[]) {
  let pieces = a.map((interval) => ({ ...interval }));
  for (const cut of b) {
    pieces = pieces.flatMap((piece) =>
      cut.end <= piece.start || cut.start >= piece.end
        ? [piece]
        : [
            ...(cut.start > piece.start
              ? [{ start: piece.start, end: cut.start }]
              : []),
            ...(cut.end < piece.end
              ? [{ start: cut.end, end: piece.end }]
              : []),
          ],
    );
  }
  return pieces;
}

const clock = (zone: Zone, at: number) => wallOf(zone, at)?.slice(11, 16) ?? "";

/**
 * `data`: the agenda read (at least that day); `date`: the day shown;
 * `now`: the instant to describe, or null before the clock is known.
 */
export function dayFlow(
  data: AgendaDto,
  date: string,
  now: number | null,
): DayFlow {
  const zone = zoneOf(data);
  const day = data.workingHours.days.find((item) => item.date === date);
  const bounds = {
    start: Date.parse(day?.startsAt ?? data.range.startsAt),
    end: Date.parse(day?.endsAt ?? data.range.endsAt),
  };
  const inside = (item: { startsAt: string; endsAt: string }) =>
    Date.parse(item.startsAt) < bounds.end &&
    Date.parse(item.endsAt) > bounds.start;
  const clip = (start: number, end: number) => ({
    start: Math.max(bounds.start, start),
    end: Math.min(bounds.end, end),
  });

  const visits: FlowVisit[] = data.appointments
    .filter(inside)
    .map((appointment) => {
      const start = Date.parse(appointment.startsAt);
      const end = Date.parse(appointment.endsAt);
      const timing: VisitTiming =
        now === null
          ? "ahead"
          : end <= now
            ? "past"
            : start <= now
              ? "now"
              : "ahead";
      return {
        appointment,
        start,
        end,
        timing,
        startsBefore: start < bounds.start,
        endsAfter: end > bounds.end,
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Visits that overlap one another (cancelled ones too, when shown) form
  // one row; a cancelled visit never holds time, though (see free time).
  const items: FlowItem[] = [];
  let group: FlowVisit[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    if (group.length === 0) return;
    const { start } = clip(group[0]!.start, group[0]!.end);
    items.push({
      kind: "visits",
      start,
      end: Math.min(bounds.end, groupEnd),
      visits: group,
    });
    group = [];
  };
  for (const visit of visits) {
    if (visit.start >= groupEnd) {
      flush();
      groupEnd = -Infinity;
    }
    group.push(visit);
    groupEnd = Math.max(groupEnd, visit.end);
  }
  flush();

  const blocks = data.blocks.filter(inside);
  for (const block of blocks) {
    const start = Date.parse(block.startsAt);
    const end = Date.parse(block.endsAt);
    items.push({
      kind: "block",
      ...clip(start, end),
      block,
      startsBefore: start < bounds.start,
      endsAfter: end > bounds.end,
    });
  }

  // Free time: her opening, minus what holds time (visits not cancelled,
  // pauses, closures). Offered only when still ahead.
  const opening = union(
    (day?.openRanges ?? []).map((range) =>
      clip(Date.parse(range.startsAt), Date.parse(range.endsAt)),
    ),
  );
  const taken = union([
    ...visits
      .filter((visit) => live(visit.appointment))
      .map((v) => clip(v.start, v.end)),
    ...blocks.map((block) =>
      clip(Date.parse(block.startsAt), Date.parse(block.endsAt)),
    ),
  ]);
  for (const free of subtract(opening, taken)) {
    // What is still ahead of a free stretch already begun is its bookable part.
    const start =
      now !== null && free.start < now && now < free.end
        ? Math.ceil(now / (5 * MINUTE)) * 5 * MINUTE
        : free.start;
    const minutes = Math.round((free.end - start) / MINUTE);
    if (minutes < MIN_FREE_MINUTES) continue;
    items.push({
      kind: "free",
      start,
      end: free.end,
      minutes,
      time: clock(zone, start),
      bookable: now === null || start >= now,
    });
  }

  // Order: by start; at the same instant, what holds time before free time.
  const rank = { block: 0, visits: 1, free: 2, now: 3 } as const;
  items.sort((a, b) => a.start - b.start || rank[a.kind] - rank[b.kind]);

  // Now: between the items before it and after it — unless a visit is
  // going on, which says it itself (inside its row).
  if (now !== null && now >= bounds.start && now < bounds.end) {
    const during = items.some(
      (item) =>
        item.kind === "visits" &&
        item.visits.some((visit) => visit.timing === "now"),
    );
    if (!during) {
      const at = items.findIndex((item) => item.start >= now);
      const marker: FlowItem = {
        kind: "now",
        start: now,
        end: now,
        time: clock(zone, now),
      };
      if (at === -1) items.push(marker);
      else items.splice(at, 0, marker);
    }
  }

  // Only on the day that holds "now": another day has no "next".
  const next =
    now === null || now < bounds.start || now >= bounds.end
      ? null
      : (visits.find(
          (visit) =>
            visit.timing === "ahead" &&
            visit.appointment.status === "confirmed" &&
            visit.start >= bounds.start,
        ) ?? null);

  const openMinutes = opening.reduce(
    (total, interval) => total + (interval.end - interval.start),
    0,
  );
  const closings = union(
    blocks
      .filter((block) => block.kind === "closed")
      .map((block) =>
        clip(Date.parse(block.startsAt), Date.parse(block.endsAt)),
      ),
  );

  return {
    date,
    bounds,
    items,
    next,
    count: visits.length,
    closed: openMinutes === 0 || subtract(opening, closings).length === 0,
  };
}

/**
 * Bookings of a period read, each counted once (by id), in the period it
 * starts in; cancelled ones only if `withCancelled`. A visit across
 * midnight is on two days but is one booking.
 */
export function distinctBookings(
  data: AgendaDto,
  days: string[],
  withCancelled = false,
) {
  const shown = data.workingHours.days.filter((day) => days.includes(day.date));
  if (shown.length === 0) return 0;
  const start = Math.min(...shown.map((day) => Date.parse(day.startsAt)));
  const end = Math.max(...shown.map((day) => Date.parse(day.endsAt)));
  return new Set(
    data.appointments
      .filter((appointment) => {
        const at = Date.parse(appointment.startsAt);
        return (withCancelled || live(appointment)) && at >= start && at < end;
      })
      .map((appointment) => appointment.id),
  ).size;
}
