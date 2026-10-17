import { EmailTransportError } from "./types";
import type { EmailTransport, OutgoingEmail, SentEmail } from "./types";

type Outcome =
  | { kind: "accept" }
  | { kind: "fail"; code: string; permanent: boolean }
  | { kind: "hang" };

/**
 * In-memory transport for tests: records every accepted message and can be
 * told to fail, or to never answer, for the next calls.
 */
export class MemoryTransport implements EmailTransport {
  readonly name = "memory";
  readonly sent: OutgoingEmail[] = [];
  readonly attempts: OutgoingEmail[] = [];
  private readonly script: Outcome[] = [];
  private counter = 0;

  failNext(code: string, permanent = false, times = 1) {
    for (let i = 0; i < times; i++) {
      this.script.push({ kind: "fail", code, permanent });
    }
  }

  hangNext() {
    this.script.push({ kind: "hang" });
  }

  async send(email: OutgoingEmail, signal: AbortSignal): Promise<SentEmail> {
    this.attempts.push(email);
    const outcome = this.script.shift() ?? { kind: "accept" };
    if (outcome.kind === "fail") {
      throw new EmailTransportError(outcome.code, outcome.permanent);
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
    this.sent.push(email);
    this.counter += 1;
    return { providerMessageId: `memory-${this.counter}` };
  }
}
