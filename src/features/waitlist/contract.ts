// The waitlist (M2-R06), as served (docs/WAITLIST_CONTRACT.md). The screens
// take their actions as a whole: real pages give them the HTTP ones
// (http-actions.ts, bound to the link's token), the design preview and the
// tests an in-memory server.
//
// No slot is ever held: an offer says a slot is free now, the first
// booking committed wins, and a missed offer leaves her request active.

/** A civil day's period, in the business's time zone (minutes of the day). */
export type WindowDto = {
  /** YYYY-MM-DD */
  localDate: string;
  startMinute: number;
  endMinute: number;
};

export type JoinWaitlistInput = {
  requestId: string;
  businessSlug: string;
  serviceId: string;
  optionChoiceIds: string[];
  /** One to five windows; empty when `anyTime`. */
  windows: WindowDto[];
  /** Every eligible window of the next days (as far as the server allows). */
  anyTime: boolean;
  firstName: string;
  email: string;
  /** She agreed to be written to when a slot frees up. */
  contactConsent: true;
};

export type WaitlistRequestDto = {
  id: string;
  state: "pending_confirmation" | "active";
  /** The last instant any of her windows still covers. */
  activeUntil: string;
};

export type WaitlistOfferDto = {
  id: string;
  version: number;
  state: "offered" | "expired" | "unavailable" | "booked";
  serviceName: string;
  startsAt: string;
  endsAt: string;
  /** Wall clock in the business's time zone: YYYY-MM-DDTHH:MM. */
  localStartsAt: string;
  timezone: string;
  businessName: string;
  priceCents: number;
  durationMinutes: number;
  currency: string;
  /** The quote this offer stands for (a digest): sent back when she books it. */
  quoteRevision: string;
  /** Until when the offer can be taken (server's clock). */
  expiresAt: string;
  /** Her request is still active (another offer may come). */
  requestActive: boolean;
};

/** An answer of the routes; error codes as the contract names them. */
export type WaitlistResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type WaitlistActions = {
  join: (
    input: JoinWaitlistInput,
  ) => Promise<WaitlistResult<WaitlistRequestDto>>;
  offer: (offerId: string) => Promise<WaitlistResult<WaitlistOfferDto>>;
  claim: (input: {
    offerId: string;
    requestId: string;
    expectedVersion: number;
    expectedQuoteRevision: string;
  }) => Promise<WaitlistResult<WaitlistOfferDto>>;
};

/** Refusals the offer screen handles by name. */
export const offerErrors = {
  notFound: "waitlist_offer_not_found",
  expired: "offer_expired",
  unavailable: "offer_unavailable",
  quoteChanged: "quote_changed",
  stale: "stale_offer",
} as const;
