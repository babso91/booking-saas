import {
  AppException,
  appErrorMessages,
  type AppErrorCode,
} from "@/lib/errors";

type DatabaseError = {
  code?: string;
  message?: string;
  hint?: string | null;
};

// Error messages raised on purpose by our SQL functions (see migrations).
const domainMessages: Record<string, AppErrorCode> = {
  business_not_found: "business_not_found",
  service_not_found: "service_not_found",
  slot_unavailable: "slot_unavailable",
  schedule_conflict: "schedule_conflict",
  appointment_not_found: "appointment_not_found",
  client_not_found: "client_not_found",
  service_unavailable: "service_unavailable",
  stale_appointment: "stale_appointment",
  invalid_status_transition: "invalid_status_transition",
  appointment_not_editable: "appointment_not_editable",
  idempotency_conflict: "idempotency_conflict",
  forbidden: "forbidden",
  unauthenticated: "unauthenticated",
  already_onboarded: "already_onboarded",
  slug_taken: "slug_taken",
  slug_reserved: "slug_reserved",
  invalid_input: "validation_error",
  invalid_timezone: "validation_error",
  invalid_first_name: "validation_error",
  invalid_last_name: "validation_error",
  invalid_email: "validation_error",
  invalid_phone: "validation_error",
  invalid_starts_at: "validation_error",
  invalid_hours: "validation_error",
  invalid_service_order: "validation_error",
  calendar_not_connected: "calendar_not_connected",
  calendar_not_found: "calendar_not_found",
  calendar_not_selectable: "calendar_not_selectable",
  calendar_disconnect_in_progress: "calendar_disconnect_in_progress",
  oauth_state_invalid: "oauth_state_invalid",
  oauth_state_expired: "oauth_state_invalid",
  calendar_refresh_token_missing: "calendar_reauth_required",
  calendar_reauth_required: "calendar_reauth_required",
  calendar_write_authorization_required:
    "calendar_write_authorization_required",
};

// SQLSTATE classes produced by constraints and RLS.
const sqlStateCodes: Record<string, AppErrorCode> = {
  "42501": "forbidden", // insufficient privilege / RLS violation
  "23P01": "conflict", // exclusion constraint
  "23505": "conflict", // unique violation
  "23503": "conflict", // foreign key violation
  "23514": "validation_error", // check violation
  "23502": "validation_error", // not null violation
  "22P02": "validation_error", // invalid text representation
  "22007": "validation_error", // invalid datetime format
  "22008": "validation_error", // datetime field overflow
  "22023": "validation_error", // invalid parameter value
  PGRST116: "not_found", // .single() matched no row
};

export function databaseErrorCode(error: DatabaseError): AppErrorCode {
  if (error.message && error.message in domainMessages) {
    return domainMessages[error.message]!;
  }

  if (error.code && error.code in sqlStateCodes) {
    return sqlStateCodes[error.code]!;
  }

  return "internal";
}

export function databaseException(
  error: DatabaseError,
  overrides: Partial<Record<AppErrorCode, AppErrorCode>> = {},
) {
  const code = overrides[databaseErrorCode(error)] ?? databaseErrorCode(error);

  // Our SQL functions name the offending input field in HINT.
  const fieldErrors =
    error.hint && code !== "internal" && /^[a-zA-Z]+$/.test(error.hint)
      ? { [error.hint]: [appErrorMessages[code]] }
      : undefined;

  return new AppException(code, { cause: error, fieldErrors });
}
