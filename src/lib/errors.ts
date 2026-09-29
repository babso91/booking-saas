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
  service_unavailable: "Cette prestation n’est pas disponible.",
  stale_appointment:
    "Ce rendez-vous a été modifié entre-temps. Rechargez-le avant de réessayer.",
  stale_block:
    "Cette période bloquée a été modifiée entre-temps. Rechargez-la avant de réessayer.",
  invalid_status_transition: "Ce changement de statut n’est pas possible.",
  appointment_not_editable:
    "Seul un rendez-vous confirmé peut être déplacé ou modifié.",
  conflict: "Cette modification entre en conflit avec des données existantes.",
  in_use: "Cet élément est utilisé et ne peut pas être supprimé.",
  invalid_credentials: "Email ou mot de passe incorrect.",
  email_not_confirmed:
    "Confirmez votre adresse email avant de vous connecter. Vérifiez votre boîte de réception.",
  email_taken: "Un compte existe déjà avec cette adresse email.",
  rate_limited: "Trop de tentatives. Merci de réessayer dans quelques minutes.",
  already_onboarded: "Votre activité est déjà configurée.",
  slug_taken:
    "Cette adresse de page est déjà utilisée. Choisissez-en une autre.",
  slug_reserved: "Cette adresse de page est réservée. Choisissez-en une autre.",
  internal: "Une erreur inattendue est survenue. Merci de réessayer.",
} as const;

export type AppErrorCode = keyof typeof appErrorMessages;

export type AppError = {
  code: AppErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; error: AppError };

export class AppException extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    code: AppErrorCode,
    options?: {
      message?: string;
      fieldErrors?: Record<string, string[]>;
      cause?: unknown;
    },
  ) {
    super(options?.message ?? appErrorMessages[code], {
      cause: options?.cause,
    });
    this.name = "AppException";
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
  }

  toAppError(): AppError {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
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
  service_unavailable: 409,
  stale_appointment: 409,
  stale_block: 409,
  invalid_status_transition: 409,
  appointment_not_editable: 409,
  conflict: 409,
  in_use: 409,
  invalid_credentials: 401,
  email_not_confirmed: 403,
  email_taken: 409,
  rate_limited: 429,
  already_onboarded: 409,
  slug_taken: 409,
  slug_reserved: 409,
  internal: 500,
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
