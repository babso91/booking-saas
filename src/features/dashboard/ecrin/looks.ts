import type { VisitLookId } from "../agenda/visit-look";

// How a visit looks in Écrin: the same states as everywhere (her statuses,
// then time: visit-look.ts), its own matter. What is ahead is a satin
// object; what is going on takes her stone; what is behind sinks into the
// surface. Every text/ground pair comes from tokens checked at 4.5:1.

export const ecrinLookClass: Record<VisitLookId, string> = {
  ahead: "ecrin-object text-ink",
  now: "bg-signature text-on-signature shadow-[0_14px_28px_-14px_rgb(var(--shadow-rgb)/0.55)]",
  completed: "bg-success-soft text-success-strong",
  past: "bg-sand text-ink-soft",
  noShow: "bg-warning-soft text-warning-strong",
  cancelled:
    "bg-paper text-ink-soft shadow-[inset_0_0_0_1.5px_var(--line-strong)] [&_[data-name]]:line-through",
};

export const ecrinLookLabel: Record<VisitLookId, string> = {
  ahead: "Confirmé",
  now: "Créneau en cours",
  completed: "Terminé",
  past: "Passé",
  noShow: "Absente",
  cancelled: "Annulé",
};
