import {
  billingErrors,
  type BillingQuoteDto,
  type BillingResult,
  type Cadence,
  type PlanChangeActions,
  type PlanChangeDto,
  type PlanId,
} from "./contract";

// An in-memory server of the PROPOSED plan-change contract, for the
// preview and the tests only. It never charges anything: a confirmed
// upgrade stays "requested" (payment not verified), never "applied" by
// itself. Provisional prices; the recipe's fixture: 1 000 now, then 4 900
// a month.

const fail = (code: string): BillingResult<never> => ({
  ok: false,
  error: { code },
});

const prices: Record<PlanId, Record<Cadence, number>> = {
  core: { monthly: 1900, yearly: 19000 },
  signature: { monthly: 4900, yearly: 49000 },
};

export function memoryPlanChange(
  options: {
    delayMs?: number;
    now?: () => number;
    start?: { plan: PlanId; cadence: Cadence };
  } = {},
) {
  const now = options.now ?? (() => Date.parse("2026-11-15T12:00:00.000Z"));
  let subscription = {
    ...(options.start ?? {
      plan: "core" as PlanId,
      cadence: "monthly" as Cadence,
    }),
    revision: 7,
  };
  let pending: PlanChangeDto | null = null;
  const quotes = new Map<string, BillingQuoteDto>();
  const receipts = new Map<
    string,
    { quoteId: string; result: BillingResult<PlanChangeDto> }
  >();
  let promoLeft = 1;
  let count = 0;
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  const actions: PlanChangeActions = {
    async current() {
      await pause();
      return {
        ok: true,
        data: {
          ...subscription,
          pending: pending ? structuredClone(pending) : null,
        },
      };
    },
    async quote({
      targetPlan,
      targetCadence,
      expectedSubscriptionRevision,
      promoCode,
    }) {
      await pause();
      if (expectedSubscriptionRevision !== subscription.revision)
        return fail(billingErrors.stateChanged);
      if (
        promoCode &&
        (promoCode.toUpperCase() !== "LANCEMENT" || promoLeft <= 0)
      )
        return fail(billingErrors.promoUnavailable);
      const upgrade =
        targetPlan === "signature" && subscription.plan === "core";
      const recurring = prices[targetPlan][targetCadence];
      const periodEnd = "2026-12-01T00:00:00.000Z";
      const discount = promoCode ? 500 : 0;
      const quote: BillingQuoteDto = {
        quoteId: `q_${(count += 1)}`,
        currency: "EUR",
        current: { plan: subscription.plan, cadence: subscription.cadence },
        target: {
          plan: targetPlan,
          cadence: targetCadence,
          priceVersionId: `${targetPlan}_${targetCadence}_v1`,
        },
        dueNowMinor: upgrade ? Math.max(0, 1000 - discount) : 0,
        nextCharge: { at: periodEnd, amountMinor: recurring },
        recurring: { amountMinor: recurring, cadence: targetCadence },
        effective: upgrade
          ? { mode: "after_verified_payment" }
          : { mode: "end_of_period", at: periodEnd },
        expiresAt: new Date(now() + 15 * 60_000).toISOString(),
        revision: subscription.revision,
        simulated: true,
      };
      quotes.set(quote.quoteId, quote);
      return { ok: true, data: structuredClone(quote) };
    },
    async confirm({ quoteId, expectedRevision, operationId }) {
      await pause();
      const earlier = receipts.get(operationId);
      if (earlier)
        return earlier.quoteId === quoteId
          ? earlier.result
          : fail("idempotency_conflict");
      const quote = quotes.get(quoteId);
      if (!quote || Date.parse(quote.expiresAt) < now())
        return fail(billingErrors.quoteExpired);
      if (
        expectedRevision !== subscription.revision ||
        quote.revision !== subscription.revision
      )
        return fail(billingErrors.stateChanged);
      if (pending) return fail(billingErrors.stateChanged);
      if (
        quote.dueNowMinor < 1000 &&
        quote.effective.mode === "after_verified_payment"
      )
        promoLeft -= 1;
      pending = {
        commandId: `cmd_${receipts.size + 1}`,
        // Never applied by itself: an upgrade waits for a verified payment.
        status:
          quote.effective.mode === "after_verified_payment"
            ? "requested"
            : "scheduled",
        target: { plan: quote.target.plan, cadence: quote.target.cadence },
        effectiveAt:
          quote.effective.mode === "end_of_period" ? quote.effective.at : null,
      };
      subscription = { ...subscription, revision: subscription.revision + 1 };
      const result = { ok: true as const, data: structuredClone(pending) };
      receipts.set(operationId, { quoteId, result });
      return result;
    },
    async cancelScheduled({ commandId }) {
      await pause();
      if (
        !pending ||
        pending.commandId !== commandId ||
        pending.status !== "scheduled"
      )
        return fail(billingErrors.stateChanged);
      pending = null;
      subscription = { ...subscription, revision: subscription.revision + 1 };
      return { ok: true, data: null };
    },
  };
  return {
    actions,
    get pending() {
      return pending;
    },
    /** Another tab changed the subscription. */
    bump() {
      subscription = { ...subscription, revision: subscription.revision + 1 };
    },
  };
}
