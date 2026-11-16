// Marketing transport (docs/GROWTH_CAMPAIGNS_CONTRACT.md): apart from the
// transactional email transport. Only a simulated one exists: no real
// marketing message can leave until consent proof, sender identity and
// budget are approved. Never logs a recipient or a message.

export type MarketingChannel = "email" | "sms";

export type MarketingMessage = {
  /** Stable per occurrence: a provider that honours it sends once. */
  deliveryKey: string;
  channel: MarketingChannel;
  recipient: string;
  rendered: {
    subject?: string;
    text: string;
    headers?: Record<string, string>;
  };
  maxUnits: number;
};

export type SendOutcome =
  | { outcome: "accepted"; providerRef: string; actualUnits?: number }
  | { outcome: "rejected" }
  | { outcome: "transient" }
  | { outcome: "unknown" };

export type LookupOutcome =
  | { outcome: "accepted"; providerRef: string; actualUnits?: number }
  | { outcome: "rejected" }
  /** The provider never saw this key: safe to send again. */
  | { outcome: "not_found" }
  | { outcome: "unknown" };

export type MarketingTransport = {
  readonly name: string;
  readonly simulated: boolean;
  send(message: MarketingMessage, signal: AbortSignal): Promise<SendOutcome>;
  /** Reconciliation of an uncertain delivery by its key. */
  lookup(deliveryKey: string): Promise<LookupOutcome>;
};

const MAX_KEYS = 10_000;

type Fault =
  /** Accepted, then the answer is lost (a timeout after acceptance). */
  | "lost_after_accept"
  /** Never reached the provider. */
  | "transient"
  | "rejected";

/**
 * The simulated provider: accepts every message once per delivery key,
 * counts what it took, and can be told to fail a key (tests, preview).
 */
export class SimulatedMarketingTransport implements MarketingTransport {
  readonly name = "simulated";
  readonly simulated = true;
  /** Units accepted per delivery key (bounded: the oldest are forgotten). */
  readonly accepted = new Map<string, number>();
  /** The messages themselves, only when asked (tests): personal data. */
  readonly messages: MarketingMessage[] = [];
  private readonly faults = new Map<string, Fault>();

  constructor(private readonly options: { keepMessages?: boolean } = {}) {}

  failNext(deliveryKey: string, fault: Fault) {
    this.faults.set(deliveryKey, fault);
  }

  async send(message: MarketingMessage): Promise<SendOutcome> {
    const fault = this.faults.get(message.deliveryKey);
    this.faults.delete(message.deliveryKey);
    if (fault === "transient") return { outcome: "transient" };
    if (fault === "rejected") return { outcome: "rejected" };
    // A second submission of one key is not sent twice.
    if (!this.accepted.has(message.deliveryKey)) {
      this.accepted.set(message.deliveryKey, message.maxUnits);
      if (this.options.keepMessages) this.messages.push(message);
      if (this.accepted.size > MAX_KEYS) {
        this.accepted.delete(this.accepted.keys().next().value!);
      }
    }
    if (fault === "lost_after_accept") return { outcome: "unknown" };
    return {
      outcome: "accepted",
      providerRef: `sim-${message.deliveryKey}`,
      actualUnits: message.maxUnits,
    };
  }

  async lookup(deliveryKey: string): Promise<LookupOutcome> {
    const units = this.accepted.get(deliveryKey);
    return units === undefined
      ? { outcome: "not_found" }
      : {
          outcome: "accepted",
          providerRef: `sim-${deliveryKey}`,
          actualUnits: units,
        };
  }
}

let shared: SimulatedMarketingTransport | undefined;

/** The marketing transport of this process: always the simulated one. */
export function getMarketingTransport(): MarketingTransport {
  shared ??= new SimulatedMarketingTransport();
  return shared;
}
