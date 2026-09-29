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
    message: "Cette période chevauche un rendez-vous existant.",
  },
  conflict: {
    title: "Conflit",
    message: "Cette modification entre en conflit avec des données existantes.",
  },
  in_use: {
    title: "Élément utilisé",
    message: "Cet élément est encore utilisé.",
  },
};

export function describeError(error: Pick<UiError, "code">) {
  return errorCopy[error.code] ?? errorCopy.internal;
}
