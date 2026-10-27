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
  /** Minutes booked (visits not cancelled). */
  bookedMinutes: number;
  visits: number;
};

export type TimelineTick = { at: number; label: string };

export type TodayModel = {
  date: string;
  /** Wall clock `HH:MM` now, or null if now is not on that date any more. */
  nowTime: string | null;
  phase: TodayPhase;
  /** No opening at all on that date (weekly hours or exceptions). */
  closed: boolean;
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

  const visits: TodayVisit[] = agenda.appointments
    .filter(
      (appointment) =>
        appointment.status !== "cancelled" &&
        dateOf(appointment.localStartsAt) === date,
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
      return { appointment, state, start, end, lane: 0, lanes: 1 };
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

  const span = spanOf(agenda, date, visits);

  return {
    date,
    nowTime,
    phase,
    closed:
      (agenda.workingHours.days.find((item) => item.date === date)?.openRanges
        .length ?? 0) === 0,
    visits,
    currents,
    current,
    next,
    span,
    ticks: ticksOf(zone, span),
    pauses: agenda.blocks
      .filter(
        (block) =>
          block.kind === "blocked" &&
          Date.parse(block.startsAt) < span.end &&
          Date.parse(block.endsAt) > span.start,
      )
      .map((block) => ({
        id: block.id,
        start: Math.max(span.start, Date.parse(block.startsAt)),
        end: Math.min(span.end, Date.parse(block.endsAt)),
        label: block.reason?.trim() || "Indisponible",
      })),
    week: weekOf(agenda, date),
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

/**
 * The day's line: its opening, widened to every visit (a visit outside the
 * opening is still hers). Closed and nothing booked: the whole civil day.
 */
function spanOf(agenda: AgendaDto, date: string, visits: TodayVisit[]) {
  const today = agenda.workingHours.days.find((item) => item.date === date);
  const bounds = [
    ...(today?.openRanges ?? []).flatMap((range) => [
      Date.parse(range.startsAt),
      Date.parse(range.endsAt),
    ]),
    ...visits.flatMap((visit) => [visit.start, visit.end]),
  ];
  if (bounds.length === 0) {
    return {
      start: Date.parse(today?.startsAt ?? agenda.range.startsAt),
      end: Date.parse(today?.endsAt ?? agenda.range.endsAt),
    };
  }
  return { start: Math.min(...bounds), end: Math.max(...bounds) };
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
  return week.workingHours.days.map((day) => {
    const openMinutes = day.openRanges.reduce(
      (total, range) =>
        total +
        (Date.parse(range.endsAt) - Date.parse(range.startsAt)) / MINUTE,
      0,
    );
    const booked = week.appointments.filter(
      (appointment) =>
        appointment.status !== "cancelled" &&
        dateOf(appointment.localStartsAt) === day.date,
    );
    return {
      date: day.date,
      isToday: day.date === today,
      openMinutes,
      bookedMinutes: booked.reduce(
        (total, appointment) => total + appointment.durationMinutes,
        0,
      ),
      visits: booked.length,
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
