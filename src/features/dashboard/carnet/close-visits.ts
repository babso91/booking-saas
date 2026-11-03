import type { PlacedAppointment } from "@/features/agenda/client/layout";
import type { AgendaAppointmentDto } from "@/features/agenda/data/agenda";

/** The smallest target a finger or a pointer is given (WCAG 2.5.8). */
export const TARGET_PX = 24;

/** One drawn piece of a visit (several when it crosses a strip without time). */
export type PieceKey = `${string}:${number}`;
export const pieceKey = (appointment: { id: string }, part: number) =>
  `${appointment.id}:${part}` as PieceKey;

/**
 * Visits too close to be touched one by one: drawn at their exact place,
 * reached through one target over all of them, then a list.
 */
export type CloseVisits = {
  /** In y minutes, from the first visit's start: never above it. */
  top: number;
  bottom: number;
  /** Each visit once, in the order of the day. */
  appointments: AgendaAppointmentDto[];
};

/**
 * Which visits of a day keep a target of their own, and which share one.
 * Each piece is given at least TARGET_PX downwards from its exact start (a
 * short visit's target, never its drawn start, is what grows). Targets that
 * would then overlap — on the page's vertical, whatever the lanes — form one
 * group. A group with a visit too short for its own target becomes
 * CloseVisits; any other group (long visits side by side) keeps its own
 * targets, as before. `scale`: pixels per y minute on screen at least.
 */
export function closeVisitsOf(
  placed: PlacedAppointment[],
  scale: number,
): { groups: CloseVisits[]; shared: Set<PieceKey> } {
  const min = TARGET_PX / scale;
  const pieces = placed
    .flatMap((visit) =>
      visit.pieces.map((piece, part) => ({
        key: pieceKey(visit.appointment, part),
        appointment: visit.appointment,
        top: piece.top,
        bottom: Math.max(piece.bottom, piece.top + min),
        short: piece.bottom - piece.top < min,
      })),
    )
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom);

  const runs: (typeof pieces)[] = [];
  let end = -Infinity;
  for (const piece of pieces) {
    if (piece.top < end) runs[runs.length - 1]!.push(piece);
    else runs.push([piece]);
    end = Math.max(end, piece.bottom);
  }

  const groups: CloseVisits[] = [];
  const shared = new Set<PieceKey>();
  for (const run of runs) {
    const appointments = [...new Set(run.map((piece) => piece.appointment))];
    // One visit in two pieces (a strip without time) is still one target.
    if (appointments.length < 2 || !run.some((piece) => piece.short)) continue;
    for (const piece of run) shared.add(piece.key);
    groups.push({
      top: run[0]!.top,
      bottom: Math.max(...run.map((piece) => piece.bottom)),
      appointments: appointments.sort(
        (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
      ),
    });
  }
  return { groups, shared };
}
