import type { TodayModel, TodayVisit } from "../client/today-model";
import { positionOf } from "../client/today-model";
import { visitLookOf, type VisitLookId } from "../agenda/visit-look";

// The geometry of Écrin's dial: the day's span on a 300° ring, open at the
// bottom; each visit a capsule on it, overlapping visits on rings of their
// own, never on top of each other. Pure, rounded to 2 decimals so that the
// server and the browser draw exactly the same paths.

export const SIZE = 540;
const C = SIZE / 2;
const SWEEP = 300;
/** The band of the visits' rings, between these radii. */
const OUTER = 234;
const BAND = 42;
const GAP = 3;
/** Pauses and closures, just inside the band. */
const HELD_RADIUS = 186;

const round = (value: number) => Math.round(value * 100) / 100;

export type Span = { start: number; end: number };

export const angleOf = (span: Span, at: number) =>
  round(-SWEEP / 2 + (positionOf(span, at) / 100) * SWEEP);

export function pointAt(degrees: number, radius: number) {
  const radians = (degrees * Math.PI) / 180;
  return [
    round(C + radius * Math.sin(radians)),
    round(C - radius * Math.cos(radians)),
  ] as const;
}

export function arcPath(from: number, to: number, radius: number) {
  const [x1, y1] = pointAt(from, radius);
  const [x2, y2] = pointAt(to, radius);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

export type DialArc = {
  id: string;
  visit: TodayVisit;
  look: VisitLookId;
  d: string;
  stroke: number;
};

/** One capsule per visit; a visit too short for its rounded ends is a dot. */
export function dialArcs(
  visits: TodayVisit[],
  span: Span,
  now: number | null,
): DialArc[] {
  const rings = Math.max(1, ...visits.map((visit) => visit.lanes));
  const stroke = round(Math.min(18, (BAND - GAP * (rings - 1)) / rings));
  return visits.map((visit) => {
    const from = angleOf(span, visit.start);
    const to = angleOf(span, visit.end);
    const radius = round(OUTER - stroke / 2 - visit.lane * (stroke + GAP));
    // Room for the rounded ends, so that neighbours do not touch.
    const inset = ((stroke / 2 + 1) / radius) * (180 / Math.PI);
    const d =
      to - from > inset * 2 + 0.02
        ? arcPath(round(from + inset), round(to - inset), radius)
        : arcPath(
            round((from + to) / 2),
            round((from + to) / 2 + 0.01),
            radius,
          );
    return {
      id: visit.appointment.id,
      visit,
      look: visitLookOf(visit.appointment, now),
      d,
      stroke,
    };
  });
}

export const heldArc = (span: Span, start: number, end: number) =>
  arcPath(angleOf(span, start), angleOf(span, end), HELD_RADIUS);

/** Hour marks; on a long span, one in three is labelled. */
export function dialTicks(ticks: TodayModel["ticks"], span: Span) {
  return ticks.map((tick, index) => {
    const angle = angleOf(span, tick.at);
    return {
      at: tick.at,
      from: pointAt(angle, 240),
      to: pointAt(angle, 248),
      labelAt: pointAt(angle, 261),
      label:
        ticks.length <= 13 || index % 3 === 0
          ? tick.label.replace(" h", "")
          : null,
    };
  });
}

/** Where the hand points: only when "now" is on the day's line. */
export function handAngle(span: Span, now: number | null) {
  return now !== null && now >= span.start && now <= span.end
    ? angleOf(span, now)
    : null;
}

export const dialCentre = C;
