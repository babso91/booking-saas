import { EmailTransportError } from "./types";
import type {
  EmailTransport,
  FailureOutcome,
  OutgoingEmail,
  SentEmail,
} from "./types";

type Outcome =
  | { kind: "accept" }
  | { kind: "fail"; code: string; outcome: FailureOutcome }
  | { kind: "acceptThenFail"; code: string }
  | { kind: "hang" };

/**
 * In-memory transport for tests: records every accepted message and can be
 * told to fail, or to never answer, for the next calls. With `idempotency`,
 * it behaves like Resend: a key already accepted with the same request is
 * answered again without a second delivery; with another request, a 409
 * invalid_idempotent_request.
 */
export class MemoryTransport implements EmailTransport {
  readonly name = "memory";
  readonly sent: OutgoingEmail[] = [];
  readonly attempts: OutgoingEmail[] = [];
  private readonly script: Outcome[] = [];
  private readonly accepted = new Map<string, { body: string; id: string }>();
  private counter = 0;

  constructor(private readonly options: { idempotency?: boolean } = {}) {}

  failNext(
    code: string,
    outcome: FailureOutcome | boolean = "retry",
    times = 1,
  ) {
    const resolved: FailureOutcome =
      outcome === true ? "permanent" : outcome === false ? "retry" : outcome;
    for (let i = 0; i < times; i++) {
      this.script.push({ kind: "fail", code, outcome: resolved });
    }
  }

  /**
   * The provider accepts the message, but its answer is lost (timeout): the
   * message counts as delivered, the worker sees a retryable failure.
   */
  acceptThenFailNext(code = "provider_timeout") {
    this.script.push({ kind: "acceptThenFail", code });
  }

  hangNext() {
    this.script.push({ kind: "hang" });
  }

  async send(email: OutgoingEmail, signal: AbortSignal): Promise<SentEmail> {
    this.attempts.push(email);
    if (this.options.idempotency) {
      const { idempotencyKey, ...request } = email;
      const body = JSON.stringify(request);
      const known = this.accepted.get(idempotencyKey);
      if (known) {
        if (known.body !== body) {
          throw new EmailTransportError(
            "provider_idempotency_conflict",
            "unconfirmed",
          );
        }
        return { providerMessageId: known.id };
      }
    }
    const outcome = this.script.shift() ?? { kind: "accept" };
    if (outcome.kind === "fail") {
      throw new EmailTransportError(outcome.code, outcome.outcome);
    }
    if (outcome.kind === "acceptThenFail") {
      this.deliver(email);
      throw new EmailTransportError(outcome.code, "retry");
    }
    if (outcome.kind === "hang") {
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    return { providerMessageId: this.deliver(email) };
  }

  private deliver(email: OutgoingEmail) {
    this.sent.push(email);
    this.counter += 1;
    const id = `memory-${this.counter}`;
    const { idempotencyKey, ...request } = email;
    this.accepted.set(idempotencyKey, { body: JSON.stringify(request), id });
    return id;
  }
}
