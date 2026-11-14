// Her subscription and invoices (M7-R03, interface). PROPOSED contract
// (docs/BILLING_SUMMARY_PROPOSAL.md): no server serves it yet, no payment
// provider is connected and no real invoice exists. The screen takes its
// actions as a whole; only the design preview and the tests give it an
// in-memory server.
//
// A payment problem is shown to her only, never publicly; her confirmed
// appointments go on during the grace period. A missing amount is never
// shown as zero.

export type SubscriptionState = "trialing" | "active" | "past_due" | "ended";

export type BillingSummaryDto = {
  plan: "core" | "signature";
  state: SubscriptionState;
  revision: number;
  /** Next renewal date (active, trialing). */
  renewsAt: string | null;
  /** past_due only: until when her rights are kept. */
  graceUntil: string | null;
  /** A cancellation planned at the end of the period, if any. */
  cancellation: { effectiveAt: string; requestedAt: string } | null;
  /** Confirmed appointments still ahead (for the cancellation screen). */
  upcomingAppointments: number;
  /** True while no payment provider is connected. */
  simulated: boolean;
};

export type InvoiceDto = {
  invoiceId: string;
  periodStart: string;
  periodEnd: string;
  status: "preparing" | "issued" | "unavailable";
  /** Frozen once issued; null while unknown (never shown as 0). */
  amountMinor: number | null;
  currency: string;
  /** A simulated document is labelled as such. */
  simulated: boolean;
};

export type BillingResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type BillingActions = {
  summary: () => Promise<BillingResult<BillingSummaryDto>>;
  invoices: () => Promise<BillingResult<InvoiceDto[]>>;
  requestCancellation: (input: {
    expectedRevision: number;
    operationId: string;
  }) => Promise<
    BillingResult<{ summary: BillingSummaryDto; receiptId: string }>
  >;
  undoCancellation: (input: {
    expectedRevision: number;
    operationId: string;
  }) => Promise<BillingResult<BillingSummaryDto>>;
  /** An ephemeral link to the provider's portal; unavailable while simulated. */
  openPortal: () => Promise<BillingResult<{ url: string }>>;
};

export const billingErrors = {
  stateChanged: "billing_state_changed",
  unavailable: "billing_unavailable",
  permissionDenied: "permission_denied",
} as const;
