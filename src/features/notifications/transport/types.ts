// Email transport: the only place that talks to an email provider. The
// worker hands it a rendered message and maps its answer onto the outbox.
//
// A transport never retries by itself (the outbox does, with backoff) and
// never logs a recipient, subject or body.

/**
 * The message of one logical email, as frozen before its first submission
 * (private.email_renderings): every attempt sends exactly this.
 */
export type EmailMessage = {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
};

export type OutgoingEmail = EmailMessage & {
  /**
   * Stable per logical email (the outbox id): a provider that honours it
   * drops a second submission of the same email (crash after acceptance).
   * Always sent with the same frozen message.
   */
  idempotencyKey: string;
};

export type SentEmail = {
  /** The provider's id for the accepted message, when it gives one. */
  providerMessageId: string | null;
};

export type EmailTransport = {
  /** Short stable name, for logs ("resend", "mailpit", "memory"). */
  readonly name: string;
  send(email: OutgoingEmail, signal: AbortSignal): Promise<SentEmail>;
};

/**
 * What a failed attempt means for the email:
 * - retry: nothing was delivered, or a resend of the same request under the
 *   same key is safe (network error, timeout, 429, 5xx, a concurrent request
 *   with the same key still in progress);
 * - permanent: the provider refused this message; retrying cannot succeed;
 * - unconfirmed: the delivery is unknown and a retry cannot settle it (the
 *   key is bound to another request): never resent, never reported as
 *   unsent.
 */
export type FailureOutcome = "retry" | "permanent" | "unconfirmed";

/**
 * A delivery failure. `code` is a stable snake_case code, stored in the
 * outbox: never a provider message, which may quote the address.
 */
export class EmailTransportError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: FailureOutcome,
  ) {
    super(code);
    this.name = "EmailTransportError";
  }
}
