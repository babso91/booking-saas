import type {
  AppointmentStatus,
  ClientFilter,
  ClientSort,
  EmailStatus,
  EmailType,
  LoyaltyEntryType,
} from "@/features/crm/types";

// Screen copy of the CRM (tu voice, as the rest of the professional UI).
// Every backend union is mapped exhaustively: a value added to the contract
// fails the type check here instead of reaching the screen raw.

export const filterLabels: Record<ClientFilter, string> = {
  all: "Toutes",
  upcoming: "Rendez-vous à venir",
  no_upcoming: "Sans rendez-vous à venir",
  visited: "Déjà venues",
  never_visited: "Jamais venues",
};

export const sortLabels: Record<ClientSort, string> = {
  name: "Nom (A → Z)",
  last_visit: "Dernière visite",
  next_appointment: "Prochain rendez-vous",
  most_visits: "Plus de visites",
  newest: "Fiche la plus récente",
};

export type StatusTone = "done" | "cancelled" | "absent" | "pending";

/**
 * A past appointment's status in the history. A `confirmed` appointment in
 * the timeline has already started (upcoming ones are not in it): it is
 * waiting for its outcome, never presented as a visit.
 */
export const appointmentStatusCopy: Record<
  AppointmentStatus,
  { label: string; tone: StatusTone }
> = {
  completed: { label: "Terminé", tone: "done" },
  cancelled: { label: "Annulé", tone: "cancelled" },
  no_show: { label: "Absente", tone: "absent" },
  confirmed: { label: "Statut à indiquer", tone: "pending" },
};

export const sourceLabel = (source: "public" | "manual") =>
  source === "public" ? "réservé en ligne" : "ajouté par toi";

export const loyaltyTitles: Record<LoyaltyEntryType, string> = {
  appointment_completed: "Points de fidélité",
  manual_adjustment: "Ajustement de points",
  reward_redeemed: "Récompense échangée",
  correction: "Correction de points",
};

/** "+10 points", "−100 points" (a real minus sign). */
export function pointsLabel(delta: number) {
  const value = Math.abs(delta);
  const unit = value > 1 ? "points" : "point";
  return `${delta < 0 ? "−" : "+"}${value} ${unit}`;
}

export const emailTitles: Record<EmailType, string> = {
  booking_confirmation: "Email de confirmation de réservation",
  appointment_reminder: "Rappel de rendez-vous",
  appointment_changed: "Email de modification de rendez-vous",
  appointment_cancelled: "Email d’annulation de rendez-vous",
  points_earned: "Email de points gagnés",
  reward_unlocked: "Email de récompense débloquée",
  reactivation: "Email de relance",
};

/**
 * What is known about an email. `sent` means handed to the provider:
 * delivery is not tracked, so never "reçu" or "délivré".
 */
export const emailStatusLabels: Record<EmailStatus, string> = {
  scheduled: "Programmé · pas encore envoyé",
  sending: "Envoi en cours",
  sent: "Envoyé",
  failed: "Échec de l’envoi",
  cancelled: "Envoi annulé",
};
