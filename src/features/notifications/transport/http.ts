import { EmailTransportError } from "./types";

/**
 * Maps an HTTP status of an email API onto a delivery failure: 408, 409
 * (an idempotent request still in progress), 429 and 5xx are retried, as
 * are 401/403 (a credential problem is fixed by configuration, the email
 * must not be lost meanwhile); other 4xx are permanent (the provider
 * rejected this message).
 */
export function httpFailure(status: number): EmailTransportError {
  if (status === 401 || status === 403) {
    return new EmailTransportError("provider_unauthorized", false);
  }
  if (status === 408 || status === 409 || status === 429) {
    return new EmailTransportError(`provider_http_${status}`, false);
  }
  if (status >= 500) {
    return new EmailTransportError("provider_unavailable", false);
  }
  return new EmailTransportError(`provider_rejected_${status}`, true);
}

/** A request that never got an HTTP answer: always retried. */
export function networkFailure(error: unknown): EmailTransportError {
  if (error instanceof EmailTransportError) return error;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new EmailTransportError("provider_timeout", false);
  }
  return new EmailTransportError("provider_network", false);
}
