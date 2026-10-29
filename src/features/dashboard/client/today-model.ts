import { dateOf } from "@/features/agenda/client/dates";
import { wallOf, zoneOf, type Zone } from "@/features/agenda/client/zone";
import type {
  AgendaAppointmentDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";

// What her "today" says, derived from the agenda the server read (the same
// DTO as the agenda: PostgreSQL is the calendar authority). Pure: given the
// day, the week and an instant, the same answer every time.
//
// Instants are compared as instants; wall-clock times only come from the
// offsets PostgreSQL sent (wallOf), never from the browser's time zone.

export type VisitState = "done" | "now" | "upcoming";

export type TodayVisit = {
  appointment: AgendaAppointmentDto;
  state: VisitState;
  /** Instants, ms. */
  start: number;
  end: number;
  /**
   * Row on the day's line when visits overlap (0-based) and how many rows
   * its group of overlapping visits needs: overlaps are shown, never hidden
   * under each other.
   */
  lane: number;
  lanes: number;
  /** Began on the day before (across midnight). */
  startsBefore: boolean;
  /** Ends on the day after. */
  endsAfter: boolean;
};

export type TodayPhase =
  /** Nothing booked today. */
  | "free"
  /** The first visit has not started. */
  | "before"
  /** A visit is going on. */
  | "during"
  /** Between two visits. */
  | "between"
  /** Every visit of the day is behind her. */
  | "after";

export type WeekDay = {
  date: string;
  isToday: boolean;
  /** Minutes open, from the real opening ranges of that date. */
  openMinutes: number;
  /**
   * Of those, minutes that can still be booked: neither closed nor blocked
   * (an exceptional closure, a lunch). The fill rate is measured on them.
   */
  bookableMinutes: number;
  /** Nothing bookable that day: weekly closing day or exceptional closure. */
  closed: boolean;
  /** Minutes booked on that day (visits not cancelled, cut at its bounds). */
  bookedMinutes: number;
  /** Visits (not cancelled) on that day, including across midnight. */
  visits: number;
};

/**
 * Why a day offers nothing: no opening hours that weekday, or an
 * exceptional closure (her "closed" exception) over all of its opening.
 */
export type Closure =
  { kind: "weekly" } | { kind: "exceptional"; reason: string | null };

export type TimelineTick = { at: number; label: string };

export type TodayModel = {
  date: string;
  /** Wall clock `HH:MM` now, or null if now is not on that date any more. */
  nowTime: string | null;
  phase: TodayPhase;
  /** The day is closed (and why), or null when it is open. */
  closure: Closure | null;
  /**
   * On an open day, the parts she closed (an exceptional "closed" over part
   * of the opening), in her wall clock: said even when nothing is booked.
   */
  closures: { id: string; from: string; to: string; reason: string | null }[];
  visits: TodayVisit[];
  /** Every visit going on now (overlaps happen: both are said). */
  currents: TodayVisit[];
  /** The first of them, or null. */
  current: TodayVisit | null;
  next: TodayVisit | null;
  /** The span the day's line covers (ms), and its hour marks. */
  span: { start: number; end: number };
  ticks: TimelineTick[];
  week: WeekDay[];
  /**
   * Bookings of the week, each counted once: by id, in the week it starts
   * in. A visit across midnight is on two days but is one booking.
   */
  weekVisits: number;
  counts: { total: number; done: number; left: number; online: number };
  /** Time she blocked today (lunch, errands…), on the day's line. */
  pauses: { id: string; start: number; end: number; label: string }[];
  /** Her own notes on what is still to come today. */
  notes: { appointment: AgendaAppointmentDto }[];
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ended = (status: AgendaAppointmentDto["status"]) =>
  status === "completed" || status === "no_show";

/**
 * `agenda`: what the server read around today (the week); `date`: today, the
 * business's civil date from PostgreSQL; `now`: the instant to describe.
 */
export function todayModel(
  agenda: AgendaDto,
  date: string,
  now: number,
): TodayModel {
  const zone = zoneOf(agenda);
  const wall = wallOf(zone, now);
  const nowTime = wall && dateOf(wall) === date ? wall.slice(11, 16) : null;

  const bounds = dayBoundsOf(agenda, date);

  // Every visit that covers part of this civil day, as PostgreSQL bounds it
  // (a 23 h or 25 h day included): one that crosses midnight is on both.
  const visits: TodayVisit[] = agenda.appointments
    .filter(
      (appointment) =>
        appointment.status !== "cancelled" &&
        Date.parse(appointment.startsAt) < bounds.end &&
        Date.parse(appointment.endsAt) > bounds.start,
    )
    .map((appointment) => {
      const start = Date.parse(appointment.startsAt);
      const end = Date.parse(appointment.endsAt);
      const state: VisitState =
        ended(appointment.status) || end <= now
          ? "done"
          : start <= now
            ? "now"
            : "upcoming";
      return {
        appointment,
        state,
        start,
        end,
        lane: 0,
        lanes: 1,
        startsBefore: start < bounds.start,
        endsAfter: end > bounds.end,
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  placeInLanes(visits);

  const currents = visits.filter((visit) => visit.state === "now");
  const current = currents[0] ?? null;
  const next = visits.find((visit) => visit.state === "upcoming") ?? null;
  const done = visits.filter((visit) => visit.state === "done").length;

  const phase: TodayPhase =
    visits.length === 0
      ? "free"
      : current
        ? "during"
        : done === 0
          ? "before"
          : next
            ? "between"
            : "after";

  const span = spanOf(agenda, date, bounds, visits);
  const week = weekOf(agenda, date);
  const closure = closureOf(agenda, date, week);

  return {
    date,
    nowTime,
    phase,
    closure,
    closures: closure ? [] : partialClosuresOf(agenda, zone, bounds),
    visits,
    currents,
    current,
    next,
    span,
    ticks: ticksOf(zone, span),
    pauses: agenda.blocks
      .filter(
        (block) =>
          Date.parse(block.startsAt) < span.end &&
          Date.parse(block.endsAt) > span.start,
      )
      .map((block) => ({
        id: block.id,
        start: Math.max(span.start, Date.parse(block.startsAt)),
        end: Math.min(span.end, Date.parse(block.endsAt)),
        label:
          block.reason?.trim() ||
          (block.kind === "closed" ? "Fermé" : "Indisponible"),
      })),
    week,
    weekVisits: weekVisitsOf(agenda),
    counts: {
      total: visits.length,
      done,
      left: visits.length - done,
      online: visits.filter((visit) => visit.appointment.source === "public")
        .length,
    },
    notes: visits
      .filter(
        (visit) =>
          visit.state !== "done" && visit.appointment.internalNotes?.trim(),
      )
      .map((visit) => ({ appointment: visit.appointment })),
  };
}

/**
 * Overlapping visits side by side: each group of visits that overlap one
 * another gets as many rows as it needs, each visit the first free row.
 */
function placeInLanes(visits: TodayVisit[]) {
  let group: TodayVisit[] = [];
  let groupEnd = -Infinity;
  const close = () => {
    const lanes = Math.max(1, ...group.map((visit) => visit.lane + 1));
    for (const visit of group) visit.lanes = lanes;
  };
  const laneEnds: number[] = [];
  for (const visit of visits) {
    if (visit.start >= groupEnd) {
      close();
      group = [];
      laneEnds.length = 0;
    }
    let lane = laneEnds.findIndex((end) => end <= visit.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = visit.end;
    visit.lane = lane;
    group.push(visit);
    groupEnd = Math.max(groupEnd, visit.end);
  }
  close();
}

/** The real bounds of a civil day, as PostgreSQL sent them. */
function dayBoundsOf(agenda: AgendaDto, date: string) {
  const day = agenda.workingHours.days.find((item) => item.date === date);
  return {
    start: Date.parse(day?.startsAt ?? agenda.range.startsAt),
    end: Date.parse(day?.endsAt ?? agenda.range.endsAt),
  };
}

/**
 * The day's line: its opening, widened to every visit (a visit outside the
 * opening is still hers), never beyond the day itself. Closed and nothing
 * booked: the whole civil day.
 */
function spanOf(
  agenda: AgendaDto,
  date: string,
  day: { start: number; end: number },
  visits: TodayVisit[],
) {
  const today = agenda.workingHours.days.find((item) => item.date === date);
  const marks = [
    ...(today?.openRanges ?? []).flatMap((range) => [
      Date.parse(range.startsAt),
      Date.parse(range.endsAt),
    ]),
    ...visits.flatMap((visit) => [visit.start, visit.end]),
  ].map((at) => Math.min(day.end, Math.max(day.start, at)));
  if (marks.length === 0) return day;
  return { start: Math.min(...marks), end: Math.max(...marks) };
}

type Interval = { start: number; end: number };

/** The union of intervals, sorted, overlaps merged. */
function union(intervals: Interval[]) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Minutes of `a` covered by `b` (both unions). */
function overlapMinutes(a: Interval[], b: Interval[]) {
  let total = 0;
  for (const x of a)
    for (const y of b)
      total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return total / MINUTE;
}

/** Her "closed" exceptions over part of this day, in her wall clock. */
function partialClosuresOf(
  agenda: AgendaDto,
  zone: Zone,
  day: Interval,
): TodayModel["closures"] {
  const clock = (at: number) => wallOf(zone, at)?.slice(11, 16) ?? "";
  return agenda.blocks
    .filter(
      (block) =>
        block.kind === "closed" &&
        Date.parse(block.startsAt) < day.end &&
        Date.parse(block.endsAt) > day.start,
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .map((block) => {
      const start = Math.max(day.start, Date.parse(block.startsAt));
      const end = Math.min(day.end, Date.parse(block.endsAt));
      return {
        id: block.id,
        from: clock(start),
        // Up to the end of the day: said as midnight, not as 00:00.
        to: end >= day.end ? "24:00" : clock(end),
        reason: block.reason?.trim() || null,
      };
    });
}

/**
 * Distinct bookings of the week read: not cancelled, starting within its
 * real bounds (first midnight to last), counted by id.
 */
function weekVisitsOf(week: AgendaDto) {
  const days = week.workingHours.days;
  if (days.length === 0) return 0;
  const start = Math.min(...days.map((day) => Date.parse(day.startsAt)));
  const end = Math.max(...days.map((day) => Date.parse(day.endsAt)));
  return new Set(
    week.appointments
      .filter((appointment) => {
        const at = Date.parse(appointment.startsAt);
        return appointment.status !== "cancelled" && at >= start && at < end;
      })
      .map((appointment) => appointment.id),
  ).size;
}

function closureOf(
  agenda: AgendaDto,
  date: string,
  week: WeekDay[],
): Closure | null {
  const day = week.find((item) => item.date === date);
  if (!day || !day.closed) return null;
  if (day.openMinutes === 0) return { kind: "weekly" };
  const bounds = dayBoundsOf(agenda, date);
  const closing = agenda.blocks.find(
    (block) =>
      block.kind === "closed" &&
      Date.parse(block.startsAt) < bounds.end &&
      Date.parse(block.endsAt) > bounds.start,
  );
  return { kind: "exceptional", reason: closing?.reason?.trim() || null };
}

/** A mark at every whole hour of the span, labelled with its wall clock. */
function ticksOf(zone: Zone, span: { start: number; end: number }) {
  const ticks: TimelineTick[] = [];
  // Whole hours in wall time; offsets are whole quarter hours at worst, so
  // step by minute until the first :00, then by hour (DST days included:
  // a repeated hour is marked twice, a skipped one not at all).
  let at = Math.ceil(span.start / MINUTE) * MINUTE;
  for (let guard = 0; guard < 60; guard += 1) {
    if (wallOf(zone, at)?.endsWith(":00")) break;
    at += MINUTE;
  }
  for (; at <= span.end; at += HOUR) {
    const wall = wallOf(zone, at);
    if (!wall) continue;
    ticks.push({ at, label: `${Number(wall.slice(11, 13))} h` });
  }
  return ticks;
}

function weekOf(week: AgendaDto, today: string): WeekDay[] {
  const span = (block: AgendaDto["blocks"][number]) => ({
    start: Date.parse(block.startsAt),
    end: Date.parse(block.endsAt),
  });
  const unavailable = union(week.blocks.map(span));
  const closings = union(
    week.blocks.filter((block) => block.kind === "closed").map(span),
  );
  return week.workingHours.days.map((day) => {
    const bounds = [
      { start: Date.parse(day.startsAt), end: Date.parse(day.endsAt) },
    ];
    const open = union(
      day.openRanges.map((range) => ({
        start: Date.parse(range.startsAt),
        end: Date.parse(range.endsAt),
      })),
    );
    const openMinutes = overlapMinutes(open, bounds);
    const bookableMinutes = openMinutes - overlapMinutes(open, unavailable);
    const visits = week.appointments
      .filter((appointment) => appointment.status !== "cancelled")
      .map((appointment) => ({
        start: Date.parse(appointment.startsAt),
        end: Date.parse(appointment.endsAt),
      }))
      .filter(
        (visit) => visit.start < bounds[0]!.end && visit.end > bounds[0]!.start,
      );
    return {
      date: day.date,
      isToday: day.date === today,
      openMinutes,
      bookableMinutes,
      // Closed: no opening, or her "closed" exceptions cover all of it (a
      // day fully blocked by pauses is still an open day, just full).
      closed:
        openMinutes === 0 || overlapMinutes(open, closings) >= openMinutes,
      bookedMinutes: visits.reduce(
        (total, visit) => total + overlapMinutes([visit], bounds),
        0,
      ),
      visits: visits.length,
    };
  });
}

/** Where an instant falls on the day's line, 0 to 100. */
export const positionOf = (span: { start: number; end: number }, at: number) =>
  span.end > span.start
    ? Math.max(
        0,
        Math.min(100, ((at - span.start) / (span.end - span.start)) * 100),
      )
    : 0;

/** Minutes left until an instant (rounded up), never negative. */
export const minutesUntil = (at: number, now: number) =>
  Math.max(0, Math.ceil((at - now) / MINUTE));
