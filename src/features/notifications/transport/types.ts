// Email transport: the only place that talks to an email provider. The
// worker hands it a rendered message and maps its answer onto the outbox.
//
// A transport never retries by itself (the outbox does, with backoff) and
// never logs a recipient, subject or body.

export type OutgoingEmail = {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Stable per logical email (the outbox id): a provider that honours it
   * drops a second submission of the same email (crash after acceptance).
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
 * A delivery failure. `permanent`: retrying the same message cannot succeed
 * (rejected address, invalid message); otherwise it is retried later.
 * `code` is a stable snake_case code, stored in the outbox: never a provider
 * message, which may quote the address.
 */
export class EmailTransportError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
    this.name = "EmailTransportError";
  }
}
