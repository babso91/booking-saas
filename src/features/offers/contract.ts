// An exact quote once the slot is chosen, with an offer or a code (R4-03).
// PROPOSED contract (docs/OFFER_QUOTE_PROPOSAL.md): no server serves it yet.
// The summary takes its actions as a whole; only the design preview and
// the tests give it an in-memory server. The real public booking keeps
// its current price until Cloud provides this.
//
// The browser never computes the price it confirms: it shows the server's
// quote and sends its reference back. A changed price is never applied
// silently, upwards or downwards: the new total is confirmed explicitly.

export type OfferQuote = {
  /** Short, opaque, tied to tenant, slot, options, rule and currency. */
  quoteRef: string;
  startsAt: string;
  baseCents: number;
  optionsCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
  durationMinutes: number;
  /** A separate amount, never part of the total's arithmetic here. */
  depositCents: number | null;
  validUntil: string;
  /** What the discount is, as the client may read it. */
  discountLabel: string | null;
  discountSource: "offer" | "code" | null;
};

export type QuoteInput = {
  serviceId: string;
  optionChoiceIds: string[];
  startsAt: string;
  coupon?: string;
};

export type OfferResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type OfferQuoteActions = {
  quote: (input: QuoteInput) => Promise<OfferResult<OfferQuote>>;
  confirm: (input: {
    quoteRef: string;
    requestId: string;
  }) => Promise<OfferResult<{ bookingId: string; totalCents: number }>>;
};

export const offerErrors = {
  /** The code cannot be used: one generic reason, never which rule. */
  couponRefused: "coupon_refused",
  quoteChanged: "quote_changed",
  offerUnavailable: "offer_unavailable",
  slotUnavailable: "slot_unavailable",
} as const;

export const money = (cents: number, currency = "EUR") =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency })
    .format(cents / 100)
    .replace(/[,.]00(?=\s)/, "");
