import type { UiError, UiErrorCode } from "./call-action";

// Screen copy for every error code, in the product's "tu" voice. Short, calm
// and actionable. Raw backend, Supabase or PostgreSQL text is never shown.
export const errorCopy: Record<
  UiErrorCode,
  { title: string; message: string }
> = {
  invalid_credentials: {
    title: "Identifiants incorrects",
    message: "L’email ou le mot de passe ne correspond pas. Réessaie.",
  },
  email_not_confirmed: {
    title: "Email à confirmer",
    message:
      "Clique sur le lien reçu par email pour activer ton compte, puis reconnecte-toi.",
  },
  // Neutral and exact: neither confirms that an account exists nor promises
  // an email (none is sent when the address is already confirmed).
  email_taken: {
    title: "Déjà inscrite ?",
    message:
      "Si tu as déjà commencé ton inscription avec cette adresse, connecte-toi ou reprends depuis le dernier email reçu.",
  },
  rate_limited: {
    title: "Un instant",
    message:
      "Trop de tentatives d’affilée. Patiente quelques minutes et réessaie.",
  },
  slug_taken: {
    title: "Lien déjà pris",
    message: "Ce lien vient d’être choisi. Choisis une des variantes.",
  },
  slug_reserved: {
    title: "Lien réservé",
    message: "Ce mot est réservé. Essaie une variante.",
  },
  already_onboarded: {
    title: "Ton espace existe déjà",
    message: "Ton activité est déjà configurée. Tu peux y accéder directement.",
  },
  unauthenticated: {
    title: "Session expirée",
    message:
      "Reconnecte-toi pour continuer. Tes réponses sont conservées sur cet appareil.",
  },
  validation_error: {
    title: "Quelques informations à revoir",
    message: "Vérifie les champs indiqués puis réessaie.",
  },
  network: {
    title: "Connexion interrompue",
    message: "Impossible de joindre le serveur. Vérifie ta connexion.",
  },
  forbidden: {
    title: "Action impossible",
    message: "Cette action n’est pas disponible pour ton compte.",
  },
  internal: {
    title: "Petit contretemps",
    message: "Quelque chose n’a pas fonctionné. Réessaie dans un instant.",
  },
  // Codes of other features: never expected here, kept for exhaustiveness.
  no_business: {
    title: "Aucune activité",
    message: "Aucune activité n’est encore associée à ton compte.",
  },
  not_found: { title: "Introuvable", message: "Cet élément est introuvable." },
  business_not_found: {
    title: "Introuvable",
    message: "Cette activité n’existe pas.",
  },
  service_not_found: {
    title: "Introuvable",
    message: "Cette prestation n’est pas disponible.",
  },
  slot_unavailable: {
    title: "Créneau indisponible",
    message: "Ce créneau n’est plus disponible.",
  },
  schedule_conflict: {
    title: "Conflit",
    message: "Ce créneau chevauche un rendez-vous ou une période bloquée.",
  },
  appointment_not_found: {
    title: "Introuvable",
    message: "Ce rendez-vous est introuvable.",
  },
  block_not_found: {
    title: "Introuvable",
    message: "Cette période bloquée est introuvable.",
  },
  client_not_found: {
    title: "Introuvable",
    message: "Cette cliente est introuvable.",
  },
  service_unavailable: {
    title: "Prestation indisponible",
    message: "Cette prestation n’est pas disponible.",
  },
  stale_appointment: {
    title: "Modifié entre-temps",
    message: "Ce rendez-vous a changé. Recharge-le avant de réessayer.",
  },
  stale_block: {
    title: "Modifié entre-temps",
    message: "Cette période a changé. Recharge-la avant de réessayer.",
  },
  invalid_status_transition: {
    title: "Action impossible",
    message: "Ce changement de statut n’est pas possible.",
  },
  appointment_not_editable: {
    title: "Action impossible",
    message: "Seul un rendez-vous confirmé peut être modifié.",
  },
  idempotency_conflict: {
    title: "Demande déjà utilisée",
    message: "Recharge le formulaire avant de réessayer.",
  },
  ambiguous_local_time: {
    title: "Heure en double",
    message: "Cette heure existe deux fois ce jour-là. Précise laquelle.",
  },
  conflict: {
    title: "Conflit",
    message: "Cette modification entre en conflit avec des données existantes.",
  },
  in_use: {
    title: "Élément utilisé",
    message: "Cet élément est encore utilisé.",
  },
  calendar_not_configured: {
    title: "Calendrier indisponible",
    message: "La synchronisation de calendrier n’est pas encore disponible.",
  },
  calendar_not_connected: {
    title: "Aucun calendrier connecté",
    message: "Connecte d’abord ton calendrier Google.",
  },
  calendar_reauth_required: {
    title: "Connexion expirée",
    message:
      "Reconnecte ton calendrier Google pour reprendre la synchronisation.",
  },
  calendar_provider_unavailable: {
    title: "Google ne répond pas",
    message: "Réessaie dans quelques minutes.",
  },
  calendar_not_found: {
    title: "Calendrier introuvable",
    message: "Ce calendrier n’existe plus. Actualise la liste.",
  },
  calendar_scope_missing: {
    title: "Accès non accordé",
    message: "Reconnecte-toi en autorisant l’accès à tes calendriers.",
  },
  oauth_state_invalid: {
    title: "Connexion expirée",
    message: "Cette demande de connexion n’est plus valable. Recommence.",
  },
};

export function describeError(error: Pick<UiError, "code">) {
  return errorCopy[error.code] ?? errorCopy.internal;
}
