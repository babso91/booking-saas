import type { UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";

// Screen copy of agenda errors (docs/PROFESSIONAL_AGENDA_CONTRACT.md). The
// backend message is never shown; wording depends on what the user acted on.

export type AgendaSubject = "appointment" | "block" | "agenda";

type Copy = { title: string; message: string };

export function agendaErrorCopy(error: UiError, subject: AgendaSubject): Copy {
  switch (error.code) {
    case "schedule_conflict":
      return subject === "block"
        ? {
            title: "Période occupée",
            message:
              "Cette période chevauche un rendez-vous. Choisis une autre période ou libère d’abord le créneau.",
          }
        : {
            title: "Créneau indisponible",
            message:
              "Ce créneau vient d’être pris ou est indisponible. Choisis-en un autre.",
          };
    case "stale_appointment":
      return {
        title: "Modifié entre-temps",
        message: "Ce rendez-vous a été modifié depuis son ouverture.",
      };
    case "stale_block":
      return {
        title: "Modifiée entre-temps",
        message: "Cette période a été modifiée depuis son ouverture.",
      };
    case "invalid_status_transition":
      return {
        title: "Action impossible",
        message: "Ce rendez-vous ne peut plus passer dans cet état.",
      };
    case "appointment_not_editable":
      return {
        title: "Rendez-vous figé",
        message:
          "Seul un rendez-vous confirmé peut changer d’horaire, de prestation ou de cliente. La note reste modifiable.",
      };
    case "idempotency_conflict":
      return {
        title: "Rien n’a été créé",
        message:
          "Cette demande avait déjà servi pour un autre rendez-vous. Recommence avec le formulaire tel qu’il est.",
      };
    case "ambiguous_local_time":
      return {
        title: "Heure en double",
        message: "Cette heure existe deux fois ce jour-là. Précise laquelle.",
      };
    case "appointment_not_found":
      return { title: "Introuvable", message: "Ce rendez-vous n’existe plus." };
    case "block_not_found":
      return { title: "Introuvable", message: "Cette période n’existe plus." };
    case "client_not_found":
      return {
        title: "Cliente introuvable",
        message:
          "Cette fiche cliente n’existe plus. Recherche-la à nouveau ou crée-la.",
      };
    case "service_unavailable":
      return {
        title: "Prestation indisponible",
        message: "Cette prestation n’est plus proposée. Choisis-en une autre.",
      };
    case "unauthenticated":
      return {
        title: "Session expirée",
        message: "Reconnecte-toi pour continuer.",
      };
    case "no_business":
      return {
        title: "Aucune activité",
        message: "Aucune activité n’est associée à ce compte.",
      };
    case "forbidden":
      return {
        title: "Accès refusé",
        message: "Cette action n’est pas autorisée pour ton compte.",
      };
    case "validation_error":
      return {
        title: "À vérifier",
        message: "Certaines informations sont à corriger.",
      };
    default:
      return describeError(error);
  }
}

/**
 * Field messages for validation errors, keyed like the backend's
 * `fieldErrors` (`time`, `endsAt`, `client.email`…). Backend texts are not
 * shown; a known field gets product copy, others a generic line.
 */
const fieldCopy: Record<string, string> = {
  date: "Choisis une date valide.",
  time: "Cette heure n’existe pas ce jour-là (passage à l’heure d’été). Choisis une autre heure.",
  serviceId: "Choisis une prestation.",
  clientId: "Choisis une cliente.",
  "client.clientId": "Choisis une cliente.",
  "client.firstName": "Indique au moins le prénom.",
  "client.lastName": "Nom trop long.",
  "client.email": "Cet email semble invalide.",
  "client.phone": "Ce numéro semble invalide.",
  internalNotes: "Note trop longue (2000 caractères maximum).",
  startsAt: "Vérifie le début de la période.",
  endsAt: "La fin doit être après le début.",
  "block.startsAt": "Vérifie le début de la période.",
  "block.endsAt": "La fin doit être après le début.",
  startDate: "Vérifie la date de début.",
  endDate: "Vérifie la date de fin.",
  "block.endDate": "Vérifie la date de fin.",
  reason: "Motif trop long (500 caractères maximum).",
  "block.reason": "Motif trop long (500 caractères maximum).",
};

export function fieldErrorsCopy(error: UiError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(error.fieldErrors ?? {})) {
    result[key.replace(/^block\./, "")] = fieldCopy[key] ?? "Vérifie ce champ.";
  }
  return result;
}
