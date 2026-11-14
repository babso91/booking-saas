// Changing her plan (M7-R02). PROPOSED contract
// (docs/PLAN_CHANGE_PROPOSAL.md): no server serves it yet and no payment
// can happen from here. The screen takes its actions as a whole; only the
// design preview and the tests give it an in-memory server, which never
// charges anything.
//
// The quote is the server's, immutable and short-lived; the screen never
// recomposes an amount. A requested change gives no right before the
// payment is verified: current rights and the planned change are shown
// apart.

export type PlanId = "core" | "signature";
export type Cadence = "monthly" | "yearly";

export type BillingQuoteDto = {
  quoteId: string;
  currency: string;
  current: { plan: PlanId; cadence: Cadence };
  target: { plan: PlanId; cadence: Cadence; priceVersionId: string };
  /** Charged when she confirms (0 for a change at the end of the period). */
  dueNowMinor: number;
  nextCharge: { at: string; amountMinor: number };
  recurring: { amountMinor: number; cadence: Cadence };
  effective:
    { mode: "after_verified_payment" } | { mode: "end_of_period"; at: string };
  expiresAt: string;
  revision: number;
  /** True while no payment provider is connected. */
  simulated: boolean;
};

export type ChangeStatus =
  "requested" | "requires_action" | "scheduled" | "applied" | "failed";

export type PlanChangeDto = {
  commandId: string;
  status: ChangeStatus;
  target: { plan: PlanId; cadence: Cadence };
  effectiveAt: string | null;
};

export type BillingResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type PlanChangeActions = {
  current: () => Promise<
    BillingResult<{
      plan: PlanId;
      cadence: Cadence;
      revision: number;
      pending: PlanChangeDto | null;
    }>
  >;
  quote: (input: {
    targetPlan: PlanId;
    targetCadence: Cadence;
    expectedSubscriptionRevision: number;
    promoCode?: string;
  }) => Promise<BillingResult<BillingQuoteDto>>;
  confirm: (input: {
    quoteId: string;
    expectedRevision: number;
    operationId: string;
  }) => Promise<BillingResult<PlanChangeDto>>;
  cancelScheduled: (input: {
    commandId: string;
    operationId: string;
  }) => Promise<BillingResult<null>>;
};

export const billingErrors = {
  quoteExpired: "quote_expired",
  stateChanged: "billing_state_changed",
  unavailable: "billing_unavailable",
  promoUnavailable: "promo_unavailable",
  permissionDenied: "permission_denied",
} as const;

export const planNames: Record<PlanId, string> = {
  core: "Core",
  signature: "Signature",
};
export const cadenceNames: Record<Cadence, string> = {
  monthly: "par mois",
  yearly: "par an",
};
