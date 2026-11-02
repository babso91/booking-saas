import {
  AuthUnknownError,
  isAuthApiError,
  isAuthError,
  isAuthRetryableFetchError,
} from "@supabase/supabase-js";

/**
 * Why Supabase Auth did not confirm a session, from the error's type and
 * HTTP status (never its message):
 *   signed_out   there is no valid session: none, expired, revoked or
 *                forged (AuthSessionMissingError, 4xx answers, an invalid
 *                JWT…). Access is refused; signing in again is the remedy.
 *   unavailable  Auth could not be asked: no answer, a 5xx, a rate limit
 *                (429), or an answer it could not read. The session may be
 *                perfectly valid: access is refused for now, but nothing
 *                signs her out and no cookie is deleted.
 * Both refuse access: an outage never lets anyone through.
 */
export type AuthFailure = "signed_out" | "unavailable";

export function authFailureOf(error: unknown): AuthFailure {
  if (isAuthRetryableFetchError(error)) return "unavailable";
  if (error instanceof AuthUnknownError) return "unavailable";
  if (isAuthApiError(error)) {
    return error.status >= 500 || error.status === 429
      ? "unavailable"
      : "signed_out";
  }
  if (isAuthError(error)) return "signed_out";
  // Not an Auth error at all (a thrown TypeError…): Auth was not reached.
  return "unavailable";
}
