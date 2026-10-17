import { EmailTransportError } from "./types";

/**
 * Maps an HTTP answer of an email API onto a delivery failure. `errorName`
 * is the provider's error type (Resend: the `name` field), read for 409
 * only:
 * - 409 concurrent_idempotent_requests / resource_locked: another request
 *   with this key is in progress; retried (same key, same message);
 * - 409 invalid_idempotent_request: the key was already used with another
 *   body; whether that request delivered is unknown, and a new key could
 *   deliver twice: unconfirmed, never resent;
 * - any other 409: retried (no evidence of a delivery conflict);
 * - 408, 429, 5xx: retried; 401/403 too (a credential problem is fixed by
 *   configuration, the email must not be lost meanwhile);
 * - other 4xx: permanent (the provider rejected this message).
 */
export function httpFailure(
  status: number,
  errorName?: string | null,
): EmailTransportError {
  if (status === 409) {
    if (errorName === "invalid_idempotent_request") {
      return new EmailTransportError(
        "provider_idempotency_conflict",
        "unconfirmed",
      );
    }
    if (errorName === "concurrent_idempotent_requests") {
      return new EmailTransportError(
        "provider_idempotency_in_progress",
        "retry",
      );
    }
    return new EmailTransportError("provider_http_409", "retry");
  }
  if (status === 401 || status === 403) {
    return new EmailTransportError("provider_unauthorized", "retry");
  }
  if (status === 408 || status === 429) {
    return new EmailTransportError(`provider_http_${status}`, "retry");
  }
  if (status >= 500) {
    return new EmailTransportError("provider_unavailable", "retry");
  }
  return new EmailTransportError(`provider_rejected_${status}`, "permanent");
}

/**
 * A request that never got an HTTP answer: the provider may or may not have
 * accepted it. Retried with the same frozen message under the same key,
 * which the provider deduplicates (within its idempotency window).
 */
export function networkFailure(error: unknown): EmailTransportError {
  if (error instanceof EmailTransportError) return error;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new EmailTransportError("provider_timeout", "retry");
  }
  return new EmailTransportError("provider_network", "retry");
}
