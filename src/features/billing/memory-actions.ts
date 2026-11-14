import {
  billingErrors,
  type BillingActions,
  type BillingResult,
  type BillingSummaryDto,
  type InvoiceDto,
} from "./contract";

// An in-memory server of the PROPOSED billing summary, for the preview and
// the tests only. No provider, no charge, no real invoice: documents are
// labelled simulated.

const fail = (code: string): BillingResult<never> => ({
  ok: false,
  error: { code },
});

export function sampleSummary(
  overrides: Partial<BillingSummaryDto> = {},
): BillingSummaryDto {
  return {
    plan: "signature",
    state: "active",
    revision: 3,
    renewsAt: "2026-12-01T00:00:00.000Z",
    graceUntil: null,
    cancellation: null,
    upcomingAppointments: 14,
    simulated: true,
    ...overrides,
  };
}

export const sampleInvoices: InvoiceDto[] = [
  {
    invoiceId: "inv-3",
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: "2026-12-01T00:00:00.000Z",
    status: "preparing",
    amountMinor: null,
    currency: "EUR",
    simulated: true,
  },
  {
    invoiceId: "inv-2",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    status: "issued",
    amountMinor: 4900,
    currency: "EUR",
    simulated: true,
  },
  {
    invoiceId: "inv-1",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    status: "unavailable",
    amountMinor: 4900,
    currency: "EUR",
    simulated: true,
  },
];

export function memoryBilling(
  options: {
    delayMs?: number;
    start?: BillingSummaryDto;
    invoices?: InvoiceDto[];
    now?: () => number;
  } = {},
) {
  let summary = structuredClone(options.start ?? sampleSummary());
  const invoices = structuredClone(options.invoices ?? sampleInvoices);
  const receipts = new Map<
    string,
    BillingResult<{ summary: BillingSummaryDto; receiptId: string }>
  >();
  const now = options.now ?? (() => Date.parse("2026-11-14T10:00:00.000Z"));
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  const actions: BillingActions = {
    async summary() {
      await pause();
      return { ok: true, data: structuredClone(summary) };
    },
    async invoices() {
      await pause();
      return { ok: true, data: structuredClone(invoices) };
    },
    async requestCancellation({ expectedRevision, operationId }) {
      await pause();
      const earlier = receipts.get(operationId);
      if (earlier) return earlier;
      if (expectedRevision !== summary.revision)
        return fail(billingErrors.stateChanged);
      if (summary.cancellation || summary.state === "ended")
        return fail(billingErrors.stateChanged);
      summary = {
        ...summary,
        revision: summary.revision + 1,
        cancellation: {
          effectiveAt: summary.renewsAt ?? new Date(now()).toISOString(),
          requestedAt: new Date(now()).toISOString(),
        },
      };
      const result = {
        ok: true as const,
        data: {
          summary: structuredClone(summary),
          receiptId: `rc-${receipts.size + 1}`,
        },
      };
      receipts.set(operationId, result);
      return result;
    },
    async undoCancellation({ expectedRevision }) {
      await pause();
      if (expectedRevision !== summary.revision || !summary.cancellation)
        return fail(billingErrors.stateChanged);
      summary = {
        ...summary,
        revision: summary.revision + 1,
        cancellation: null,
      };
      return { ok: true, data: structuredClone(summary) };
    },
    async openPortal() {
      await pause();
      // No provider is connected: there is no portal to open.
      return fail(billingErrors.unavailable);
    },
  };
  return {
    actions,
    get summary() {
      return summary;
    },
    bump() {
      summary = { ...summary, revision: summary.revision + 1 };
    },
  };
}
