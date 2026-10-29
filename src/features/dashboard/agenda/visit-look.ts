import type { AgendaAppointmentDto } from "@/features/agenda/data/agenda";

// How a visit looks in the Studio planning, from what is known only: her
// own statuses first (completed, no-show, cancelled), then time (a
// confirmed slot already over, going on, or ahead). A started slot is not
// a service known to have started: it is said as a slot.
//
// Every pair is drawn from the palette's tokens, so it reads with any
// signature colour, light or dark (text on ground checked by the palette
// tests; the signature field's ink is computed for any colour).

export type VisitLookId =
  "cancelled" | "noShow" | "completed" | "past" | "now" | "ahead";

export const visitLooks: Record<
  VisitLookId,
  { label: string; className: string }
> = {
  cancelled: {
    label: "Annulé",
    className:
      "bg-paper text-ink-soft shadow-[inset_0_0_0_1.5px_var(--line-strong)] [&_[data-name]]:line-through",
  },
  noShow: {
    label: "Absente",
    className:
      "bg-warning-soft text-warning-strong shadow-[inset_4px_0_0_var(--warning)]",
  },
  completed: {
    label: "Terminé",
    className:
      "bg-paper-raised text-ink shadow-[inset_0_0_0_2px_var(--success)]",
  },
  past: {
    label: "Passé",
    className:
      "bg-paper-raised text-ink-soft shadow-[inset_0_0_0_2px_var(--line-strong)]",
  },
  now: {
    label: "Créneau en cours",
    className: "bg-signature text-on-signature",
  },
  ahead: {
    label: "Confirmé",
    className: "bg-ink text-paper",
  },
};

export function visitLookOf(
  appointment: Pick<AgendaAppointmentDto, "status" | "startsAt" | "endsAt">,
  now: number | null,
): VisitLookId {
  if (appointment.status === "cancelled") return "cancelled";
  if (appointment.status === "no_show") return "noShow";
  if (appointment.status === "completed") return "completed";
  if (now === null) return "ahead";
  if (Date.parse(appointment.endsAt) <= now) return "past";
  if (Date.parse(appointment.startsAt) <= now) return "now";
  return "ahead";
}

/** Hatching for time she holds back (pauses, closures), from tokens. */
export const hatch =
  "bg-[repeating-linear-gradient(-45deg,transparent_0_6px,var(--line)_6px_8px)]";
