import type {
  ClientHubActionRefusal,
  ClientHubAppointmentActionDto,
} from "@/features/client-hub/types";

import type { HubErrorCode } from "./api";
import { longDay, timeOf } from "./format";

// The words of her own changes to an appointment (cancel, move): what the
// server allows, until when, and why not. Nothing is decided here: the
// server's `actions` say what is open, and every change is validated by
// the server again when it is sent.

/** « jusqu’au jeudi 12 novembre à 14:00 » */
export function deadlineText(
  action: ClientHubAppointmentActionDto,
  timeZone: string,
  now = new Date(),
): string | null {
  if (!action.allowed || !action.deadlineAt) return null;
  return `jusqu’au ${longDay(action.deadlineAt, timeZone, now)} à ${timeOf(action.deadlineAt, timeZone)}`;
}

/** Why an action is closed, and what she can do instead. */
export function refusalText(
  reason: ClientHubActionRefusal | null,
  what: "cancel" | "reschedule",
  businessName: string,
): string {
  const verb = what === "cancel" ? "annuler" : "déplacer";
  switch (reason) {
    case "policy_cutoff_passed":
      return `Le délai pour ${verb} ce rendez-vous en ligne est passé. Contactez ${businessName}.`;
    case "appointment_not_editable":
      return `Ce rendez-vous ne peut plus être modifié.`;
    default:
      return `Pour ${verb} ce rendez-vous, contactez directement ${businessName}.`;
  }
}

export type ActionFailure = {
  title: string;
  message: string;
  /** What the screen should do next. */
  next:
    /** Same request again (same id): safe after a lost answer. */
    | "retry"
    /** The appointment changed or its deadline passed: read it again. */
    | "reload"
    /** Only the target slot is gone: choose another one. */
    | "choose-again"
    | "none";
};

/**
 * A refused or unanswered change, in her words. In every case the server
 * changed nothing unless it said so: her appointment is as it was.
 */
export function actionFailure(
  code: HubErrorCode | string,
  what: "cancel" | "reschedule",
): ActionFailure {
  const kept =
    what === "cancel"
      ? "Votre rendez-vous est toujours réservé."
      : "Votre rendez-vous reste à son horaire actuel.";
  switch (code) {
    case "network":
      return {
        title: "Pas de réponse",
        message: `Nous n’avons pas reçu de réponse. Réessayez : la même demande ne sera jamais appliquée deux fois.`,
        next: "retry",
      };
    case "slot_unavailable":
      return {
        title: "Ce créneau vient d’être pris",
        message: `${kept} Choisissez un autre créneau.`,
        next: "choose-again",
      };
    case "policy_cutoff_passed":
      return {
        title: "Le délai est passé",
        message: `${kept} Il n’est plus possible de le modifier en ligne.`,
        next: "reload",
      };
    case "stale_appointment":
    case "appointment_not_editable":
      return {
        title: "Ce rendez-vous a changé",
        message: `Il a été modifié entre-temps. Voici son état actuel.`,
        next: "reload",
      };
    case "idempotency_conflict":
      return {
        title: "Demande déjà traitée autrement",
        message: `${kept} Rechargez la page avant de réessayer.`,
        next: "reload",
      };
    case "rate_limited":
      return {
        title: "Trop de demandes",
        message: `${kept} Réessayez dans quelques minutes.`,
        next: "none",
      };
    default:
      return {
        title: "La demande n’a pas abouti",
        message: `${kept} Réessayez dans un instant.`,
        next: "retry",
      };
  }
}
