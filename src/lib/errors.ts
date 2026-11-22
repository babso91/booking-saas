import type { ZodError } from "zod";

// Stable error codes shared by Server Actions and Route Handlers. The code is
// the contract with the frontend; the message is a French default for display.
export const appErrorMessages = {
  validation_error: "Certaines informations sont invalides.",
  unauthenticated: "Vous devez être connectée pour effectuer cette action.",
  no_business: "Aucune activité n’est associée à ce compte.",
  forbidden: "Vous n’avez pas accès à cette ressource.",
  not_found: "Élément introuvable.",
  business_not_found: "Cette activité n’existe pas.",
  service_not_found: "Cette prestation n’est pas disponible.",
  slot_unavailable:
    "Ce créneau n’est plus disponible. Merci d’en choisir un autre.",
  schedule_conflict:
    "Ce créneau chevauche un rendez-vous ou une période bloquée. Choisissez un autre horaire ou libérez d’abord la période.",
  appointment_not_found: "Ce rendez-vous est introuvable.",
  block_not_found: "Cette période bloquée est introuvable.",
  client_not_found: "Cette cliente est introuvable.",
  client_email_conflict:
    "Une autre fiche cliente utilise déjà cette adresse email.",
  stale_client:
    "Cette fiche cliente a été modifiée entre-temps. Rechargez-la avant de réessayer.",
  client_has_upcoming_appointments:
    "Cette cliente a encore un rendez-vous à venir : annulez-le avant d’effacer ses données.",
  client_erasure_busy:
    "Un e-mail est en cours d’envoi à cette cliente. Réessayez dans un instant.",
  client_erased: "Les données de cette cliente ont été effacées.",
  note_not_found: "Cette note est introuvable.",
  note_deleted:
    "Cette note a déjà été enregistrée, puis supprimée. Elle n’a pas été recréée.",
  stale_note:
    "Cette note a été modifiée entre-temps. Rechargez-la avant de réessayer.",
  service_unavailable: "Cette prestation n’est pas disponible.",
  stale_site_draft:
    "Le brouillon du site a été modifié entre-temps. Rechargez-le avant de réessayer.",
  site_not_found: "Ce site n’a pas encore de brouillon.",
  site_business_changed:
    "Cette page appartient à une autre activité que celle de la session : rien n’a été enregistré. Rechargez la page.",
  site_not_published: "Ce site n’est pas encore publié.",
  site_version_not_found: "Cette version du site n’existe pas.",
  site_unreadable:
    "Certains textes du site ne seraient pas lisibles. Corrigez les couleurs avant de publier.",
  site_asset_unavailable:
    "Une photo du site n’est pas (ou plus) disponible. Choisissez-en une autre.",
  site_asset_in_use:
    "Cette photo est utilisée par le brouillon ou une version publiée. Retirez-la, ou révoquez-la.",
  site_photo_not_found: "Cette photo est introuvable.",
  site_photo_revoked:
    "Cette photo a été révoquée. Elle ne peut plus être utilisée.",
  site_photo_unsupported:
    "Ce fichier n’est pas une photo JPEG, PNG, WebP ou AVIF.",
  site_photo_too_large: "Cette photo est trop lourde (10 Mo au plus).",
  site_photo_invalid:
    "Cette photo est trop petite (320 px au moins de côté) ou trop allongée.",
  site_photo_cleanup_pending:
    "L’opération est enregistrée, mais des fichiers de la photo n’ont pas encore pu être supprimés. Réessayez : leur suppression sera reprise.",
  stale_service:
    "Cette prestation a été modifiée entre-temps. Rechargez-la avant de réessayer.",
  service_deleted:
    "Cette prestation a déjà été créée, puis supprimée. Elle n’a pas été recréée.",
  category_not_found: "Cette catégorie n’existe plus.",
  stale_category:
    "Cette catégorie a été modifiée entre-temps. Rechargez-la avant de réessayer.",
  category_deleted:
    "Cette catégorie a déjà été créée, puis supprimée. Elle n’a pas été recréée.",
  options_incomplete:
    "Les options de cette prestation n’ont pas été chargées en entier, ou ont changé. Rechargez-la avant d’enregistrer.",
  options_required:
    "Choisissez une réponse pour chaque option obligatoire de cette prestation.",
  option_choice_unavailable:
    "Une option choisie n’est plus proposée. Rechargez la prestation pour voir les options actuelles.",
  quote_changed:
    "Le prix ou la durée de cette prestation a changé. Vérifiez le nouveau montant avant de réserver.",
  booking_unavailable:
    "La réservation en ligne est momentanément indisponible. Merci de réessayer plus tard.",
  stale_business_hours:
    "Les horaires ont été modifiés entre-temps. Rechargez-les avant de réessayer.",
  stale_appointment:
    "Ce rendez-vous a été modifié entre-temps. Rechargez-le avant de réessayer.",
  stale_block:
    "Cette période bloquée a été modifiée entre-temps. Rechargez-la avant de réessayer.",
  invalid_status_transition: "Ce changement de statut n’est pas possible.",
  appointment_not_editable:
    "Seul un rendez-vous confirmé peut être déplacé ou modifié.",
  idempotency_conflict:
    "Cette demande a déjà été utilisée pour un autre rendez-vous. Rechargez le formulaire.",
  ambiguous_local_time:
    "Cette heure existe deux fois ce jour-là (changement d’heure). Précisez laquelle.",
  conflict: "Cette modification entre en conflit avec des données existantes.",
  in_use: "Cet élément est utilisé et ne peut pas être supprimé.",
  invalid_credentials: "Email ou mot de passe incorrect.",
  email_not_confirmed:
    "Confirmez votre adresse email avant de vous connecter. Vérifiez votre boîte de réception.",
  email_taken: "Un compte existe déjà avec cette adresse email.",
  rate_limited: "Trop de tentatives. Merci de réessayer dans quelques minutes.",
  already_onboarded: "Votre activité est déjà configurée.",
  beta_invitation_required:
    "L’accès à la bêta se fait sur invitation. Utilisez le lien personnel que vous avez reçu.",
  invitation_invalid:
    "Ce lien d’invitation n’est pas valide. Vérifiez qu’il est complet, ou demandez-en un nouveau.",
  invitation_expired: "Ce lien d’invitation a expiré. Demandez-en un nouveau.",
  invitation_used:
    "Cette invitation a déjà été utilisée. Connectez-vous avec votre compte.",
  invitation_email_mismatch:
    "Cette invitation est liée à une autre adresse email. Utilisez l’adresse à laquelle vous l’avez reçue.",
  session_revocation_failed:
    "Les autres connexions à ce compte n’ont pas pu être fermées : l’invitation n’a pas été activée. Réessayez dans quelques instants.",
  slug_taken:
    "Cette adresse de page est déjà utilisée. Choisissez-en une autre.",
  slug_reserved: "Cette adresse de page est réservée. Choisissez-en une autre.",
  calendar_not_configured:
    "La synchronisation de calendrier n’est pas disponible pour le moment.",
  calendar_not_connected: "Aucun calendrier externe n’est connecté.",
  calendar_reauth_required:
    "La connexion à votre calendrier a expiré. Reconnectez-le pour reprendre la synchronisation.",
  calendar_provider_unavailable:
    "Le service de calendrier ne répond pas. Merci de réessayer dans quelques minutes.",
  calendar_not_found: "Ce calendrier est introuvable.",
  calendar_not_selectable:
    "Ce calendrier ne partage que ses disponibilités : ses événements ne peuvent pas être lus pour bloquer des créneaux.",
  calendar_disconnect_in_progress:
    "La déconnexion précédente est en cours de finalisation. Merci de réessayer dans deux minutes.",
  calendar_scope_missing:
    "L’accès à vos calendriers n’a pas été accordé. Reconnectez-vous en autorisant l’accès demandé.",
  calendar_write_authorization_required:
    "Booking n’a pas encore l’autorisation d’écrire dans Google Agenda. Autorisez l’accès pour activer la copie de vos rendez-vous.",
  calendar_account_mismatch:
    "Ce compte Google n’est pas celui qui est connecté. Autorisez l’accès avec le même compte Google.",
  oauth_state_invalid:
    "Cette demande de connexion a expiré ou a déjà été utilisée. Recommencez la connexion.",
  stale_loyalty_program:
    "Le programme de fidélité a été modifié entre-temps. Rechargez-le avant de réessayer.",
  loyalty_program_inactive: "Le programme de fidélité n’est pas activé.",
  reward_not_found: "Cette récompense est introuvable.",
  reward_unavailable: "Cette récompense n’est pas disponible.",
  stale_reward:
    "Cette récompense a été modifiée entre-temps. Rechargez-la avant de réessayer.",
  insufficient_points: "Le solde de points est insuffisant.",
  redemption_not_found: "Cette récompense attribuée est introuvable.",
  invalid_redemption_transition:
    "Cette récompense a déjà été utilisée ou annulée.",
  loyalty_entry_not_found: "Ce mouvement de points est introuvable.",
  loyalty_entry_not_reversible:
    "Seul un ajustement manuel peut être annulé ici.",
  client_hub_unauthenticated:
    "Votre session a expiré. Reconnectez-vous avec un nouveau code.",
  client_hub_code_invalid:
    "Ce code n’est pas valable. Vérifiez-le ou demandez-en un nouveau.",
  client_hub_unavailable:
    "L’espace client est momentanément indisponible. Merci de réessayer plus tard.",
  client_hub_not_found: "Élément introuvable dans votre espace client.",
  client_hub_email_required:
    "Cette fiche cliente n’a pas d’adresse email : ajoutez-la avant d’ouvrir l’espace client.",
  context_changed:
    "Votre session a changé (autre compte ou autre activité). Rechargez la page.",
  auth_unavailable:
    "La connexion ne peut pas être vérifiée pour le moment. Vous êtes toujours connectée : réessayez dans un instant.",
  atelier_access_expired: "Ce projet Atelier n’est pas accessible.",
  atelier_quote_changed: "Le devis de ce projet a changé : relisez-le.",
  atelier_out_of_scope:
    "Cette demande sort du devis : un devis à part est nécessaire, rien n’est facturé sans votre accord.",
  atelier_revision_limit_reached:
    "Toutes les corrections incluses ont été utilisées.",
  internal: "Une erreur inattendue est survenue. Merci de réessayer.",
  policy_cutoff_passed:
    "Le délai pour modifier ce rendez-vous depuis votre espace est passé. Contactez l’établissement.",
  policy_unavailable:
    "Ce rendez-vous ne peut pas être modifié depuis votre espace. Contactez l’établissement.",
  waitlist_unavailable:
    "La liste d’attente n’est pas ouverte pour cet établissement.",
  waitlist_request_not_found:
    "Ce lien n’est plus valable. Inscrivez-vous de nouveau si besoin.",
  waitlist_offer_not_found: "Offre introuvable.",
  offer_expired: "Cette offre a expiré.",
  offer_unavailable: "Ce créneau vient d’être réservé.",
  stale_offer: "Cette offre a changé. Relisez-la.",
  version_conflict:
    "Ces informations ont changé entre-temps. Rechargez puis réessayez.",
  last_owner:
    "C’est la seule propriétaire : son accès ne peut pas être retiré.",
  upcoming_appointments:
    "Cette personne a des rendez-vous à venir : déplacez-les ou annulez-les avant de la retirer de la réservation.",
  permission_denied: "Votre rôle ne permet pas cette action.",
  role_unavailable:
    "Ce rôle n’est pas encore disponible : invitez cette personne comme administratrice.",
  access_exists: "Cette personne a déjà accès au logiciel.",
  team_limit_reached: "Votre équipe a atteint le nombre maximal de profils.",
  already_member: "Ce compte appartient déjà à une activité.",
  form_expired: "Ce formulaire n’est plus à remplir : la date est passée.",
  form_revoked: "Ce formulaire n’est plus demandé.",
  stale_form: "Ce formulaire a changé. Relisez-le avant de l’envoyer.",
  field_required: "Cette réponse est obligatoire.",
  invalid_template:
    "Ce modèle n’est pas valide : vérifiez les questions et leurs conditions.",
  form_already_submitted: "Ce formulaire a déjà été rempli.",
  form_already_assigned: "Ce formulaire est déjà demandé pour ce rendez-vous.",
  form_limit_reached:
    "Vous avez atteint le nombre maximal de modèles de formulaire.",
  too_many_occurrences: "Une série compte au plus 12 rendez-vous.",
  calendar_conflict:
    "Une ou plusieurs dates ne sont plus libres : rien n’a été créé.",
  series_stale: "Cet aperçu n’est plus valable : rien n’a été créé.",
  invitation_password_required:
    "Choisissez votre mot de passe pour rejoindre l’équipe.",
  invitation_email_unavailable:
    "L’e-mail d’invitation n’a pas pu partir. Réessayez plus tard.",
  unsubscribe_link_invalid: "Ce lien de désinscription n’est pas valide.",
  consent_link_invalid: "Ce lien de confirmation n’est pas valide ou a expiré.",
  consent_direct_only:
    "Seule la cliente peut donner son accord, par exemple en réservant. Vous pouvez enregistrer un retrait.",
  consent_text_conflict:
    "Cette version de texte existe déjà avec un autre contenu.",
  consent_text_not_draft: "Seul un texte en brouillon peut être activé.",
  consent_text_changed: "Le texte a changé depuis sa relecture : relisez-le.",
  unsubscribe_undo_unavailable:
    "Ce changement ne peut plus être annulé depuis ce lien.",
  estimate_stale:
    "L’estimation n’est plus à jour : rien n’a été planifié. Relancez l’estimation.",
  quota_exceeded: "Ce plafond dépasse le budget restant du mois.",
  campaign_not_found: "Cette campagne est introuvable.",
  campaign_closed: "Cette campagne ne peut plus changer d’état.",
  referral_unavailable:
    "Le parrainage n’est pas proposé par cet établissement.",
  coupon_refused: "Ce code ne peut pas être utilisé pour cette réservation.",
  promotion_exhausted:
    "Cette offre n’est plus disponible. Le nouveau total est à confirmer.",
  coupon_code_taken: "Ce code existe déjà.",
  promotion_not_found: "Cette promotion est introuvable.",
  quote_expired: "Ce devis a expiré : demandez-en un nouveau.",
  billing_state_changed:
    "Votre abonnement a changé entre-temps. Rechargez puis réessayez.",
  billing_unavailable: "La facturation n’est pas encore disponible en ligne.",
  promo_unavailable: "Ce code promotionnel ne peut pas être utilisé.",
  domain_taken: "Ce nom de domaine est déjà relié à un autre site.",
  proof_expired:
    "La vérification a expiré : une nouvelle valeur est à publier dans le DNS.",
  domain_generation_changed:
    "Une nouvelle vérification a été lancée ailleurs. Rechargez.",
  domain_unavailable:
    "Le domaine personnalisé n’est pas disponible pour le moment.",
} as const;

export type AppErrorCode = keyof typeof appErrorMessages;

/** The existing record a write collided with (`client_email_conflict`). */
// What a conflict points to: the client record that already has this email
// (client_email_conflict), or her current site draft (stale_site_draft).
export type AppErrorConflict =
  | { clientId: string; displayName: string; currentRevision?: undefined }
  | { currentRevision: number; clientId?: undefined; displayName?: undefined };

export type AppError = {
  code: AppErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
  conflict?: AppErrorConflict;
};

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; error: AppError };

export class AppException extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  readonly conflict?: AppErrorConflict;

  constructor(
    code: AppErrorCode,
    options?: {
      message?: string;
      fieldErrors?: Record<string, string[]>;
      conflict?: AppErrorConflict;
      cause?: unknown;
    },
  ) {
    super(options?.message ?? appErrorMessages[code], {
      cause: options?.cause,
    });
    this.name = "AppException";
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
    this.conflict = options?.conflict;
  }

  toAppError(): AppError {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
      ...(this.conflict ? { conflict: this.conflict } : {}),
    };
  }
}

export const httpStatusByErrorCode: Record<AppErrorCode, number> = {
  validation_error: 400,
  unauthenticated: 401,
  no_business: 403,
  forbidden: 403,
  not_found: 404,
  business_not_found: 404,
  service_not_found: 404,
  slot_unavailable: 409,
  schedule_conflict: 409,
  appointment_not_found: 404,
  block_not_found: 404,
  client_not_found: 404,
  client_email_conflict: 409,
  stale_client: 409,
  client_has_upcoming_appointments: 409,
  client_erasure_busy: 409,
  client_erased: 410,
  note_not_found: 404,
  note_deleted: 410,
  stale_note: 409,
  service_unavailable: 409,
  stale_site_draft: 409,
  site_not_found: 404,
  site_business_changed: 409,
  site_not_published: 404,
  site_version_not_found: 404,
  site_unreadable: 422,
  site_asset_unavailable: 409,
  site_asset_in_use: 409,
  site_photo_not_found: 404,
  site_photo_revoked: 410,
  site_photo_unsupported: 415,
  site_photo_too_large: 413,
  site_photo_invalid: 422,
  site_photo_cleanup_pending: 503,
  stale_service: 409,
  service_deleted: 410,
  category_not_found: 404,
  stale_category: 409,
  category_deleted: 410,
  options_incomplete: 409,
  options_required: 422,
  option_choice_unavailable: 409,
  quote_changed: 409,
  stale_business_hours: 409,
  booking_unavailable: 503,
  stale_appointment: 409,
  stale_block: 409,
  invalid_status_transition: 409,
  appointment_not_editable: 409,
  idempotency_conflict: 409,
  ambiguous_local_time: 400,
  conflict: 409,
  in_use: 409,
  invalid_credentials: 401,
  email_not_confirmed: 403,
  email_taken: 409,
  rate_limited: 429,
  already_onboarded: 409,
  beta_invitation_required: 403,
  invitation_invalid: 400,
  invitation_expired: 410,
  invitation_used: 409,
  invitation_email_mismatch: 403,
  session_revocation_failed: 503,
  slug_taken: 409,
  slug_reserved: 409,
  calendar_not_configured: 503,
  calendar_not_connected: 409,
  calendar_reauth_required: 409,
  calendar_provider_unavailable: 503,
  calendar_not_found: 404,
  calendar_not_selectable: 400,
  calendar_disconnect_in_progress: 409,
  calendar_scope_missing: 400,
  calendar_write_authorization_required: 409,
  calendar_account_mismatch: 409,
  oauth_state_invalid: 400,
  stale_loyalty_program: 409,
  loyalty_program_inactive: 409,
  reward_not_found: 404,
  reward_unavailable: 409,
  stale_reward: 409,
  insufficient_points: 409,
  redemption_not_found: 404,
  invalid_redemption_transition: 409,
  loyalty_entry_not_found: 404,
  loyalty_entry_not_reversible: 409,
  client_hub_unauthenticated: 401,
  client_hub_code_invalid: 400,
  client_hub_unavailable: 503,
  client_hub_not_found: 404,
  client_hub_email_required: 409,
  context_changed: 409,
  auth_unavailable: 503,
  atelier_access_expired: 404,
  atelier_quote_changed: 409,
  atelier_out_of_scope: 422,
  atelier_revision_limit_reached: 409,
  internal: 500,
  policy_cutoff_passed: 409,
  policy_unavailable: 409,
  waitlist_unavailable: 409,
  waitlist_request_not_found: 404,
  waitlist_offer_not_found: 404,
  offer_expired: 409,
  offer_unavailable: 409,
  stale_offer: 409,
  version_conflict: 409,
  last_owner: 409,
  upcoming_appointments: 409,
  permission_denied: 403,
  role_unavailable: 422,
  access_exists: 409,
  team_limit_reached: 409,
  already_member: 409,
  form_expired: 410,
  form_revoked: 409,
  stale_form: 409,
  field_required: 422,
  invalid_template: 422,
  form_already_submitted: 409,
  form_already_assigned: 409,
  form_limit_reached: 409,
  too_many_occurrences: 422,
  calendar_conflict: 409,
  series_stale: 409,
  invitation_password_required: 403,
  invitation_email_unavailable: 503,
  unsubscribe_link_invalid: 404,
  consent_link_invalid: 404,
  consent_direct_only: 403,
  consent_text_conflict: 409,
  consent_text_not_draft: 409,
  consent_text_changed: 409,
  unsubscribe_undo_unavailable: 409,
  estimate_stale: 409,
  quota_exceeded: 409,
  campaign_not_found: 404,
  campaign_closed: 409,
  referral_unavailable: 409,
  coupon_refused: 422,
  promotion_exhausted: 409,
  coupon_code_taken: 409,
  promotion_not_found: 404,
  quote_expired: 409,
  billing_state_changed: 409,
  billing_unavailable: 503,
  promo_unavailable: 422,
  domain_taken: 409,
  proof_expired: 409,
  domain_generation_changed: 409,
  domain_unavailable: 503,
};

export function validationException(error: ZodError) {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root";
    (fieldErrors[key] ??= []).push(issue.message);
  }

  return new AppException("validation_error", { fieldErrors, cause: error });
}

// Converts anything thrown by the domain layer into a serialisable error. Only
// AppException carries a user-facing message; everything else is reported as
// `internal` so database or runtime details never reach the client.
export function toAppError(error: unknown): AppError {
  if (error instanceof AppException && error.code !== "internal") {
    return error.toAppError();
  }

  return { code: "internal", message: appErrorMessages.internal };
}
