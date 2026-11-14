import {
  offerErrors,
  type OfferQuote,
  type OfferQuoteActions,
  type OfferResult,
  type QuoteInput,
} from "./contract";

// An in-memory server of the PROPOSED quote contract, for the preview and
// the tests only. The recipe's fixture: service 6000, options 1500, base
// 7500, 15 % off → 1125, total 6375; two slots the same day, only one
// eligible; a global quota of 1. Nothing is booked or charged.

const fail = (code: string): OfferResult<never> => ({
  ok: false,
  error: { code },
});

export const ELIGIBLE = "2026-11-17T13:00:00.000Z"; // 14:00 Paris, off-peak
export const REGULAR = "2026-11-17T17:00:00.000Z"; // 18:00 Paris

export function memoryOfferQuote(
  options: { delayMs?: number; quota?: number; now?: () => number } = {},
) {
  let quota = options.quota ?? 1;
  let count = 0;
  const quotes = new Map<string, OfferQuote>();
  const quotaKeys = new Map<string, string | null>();
  const receipts = new Map<
    string,
    {
      quoteRef: string;
      result: OfferResult<{ bookingId: string; totalCents: number }>;
    }
  >();
  const taken = new Set<string>();
  const now = options.now ?? (() => Date.parse("2026-11-14T10:00:00.000Z"));
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  function compute(input: QuoteInput) {
    const baseCents = 6000;
    const optionsCents = input.optionChoiceIds.length ? 1500 : 0;
    const basis = baseCents + optionsCents;
    const code = input.coupon?.trim().toUpperCase();
    let discount: {
      cents: number;
      label: string;
      source: "offer" | "code";
      quotaKey: string | null;
    } | null = null;
    if (code) {
      if (code !== "BIENVENUE10") return null;
      discount = {
        cents: Math.round(basis * 0.1),
        label: "Code BIENVENUE10 : −10 %",
        source: "code",
        quotaKey: null,
      };
    } else if (input.startsAt === ELIGIBLE && quota > 0) {
      discount = {
        cents: Math.round(basis * 0.15),
        label: "Heure creuse : −15 %",
        source: "offer",
        quotaKey: "offpeak",
      };
    }
    const discountCents = Math.min(discount?.cents ?? 0, basis);
    return {
      baseCents,
      optionsCents,
      discountCents,
      totalCents: basis - discountCents,
      discountLabel: discount?.label ?? null,
      discountSource: discount?.source ?? null,
      quotaKey: discount?.quotaKey ?? null,
    };
  }

  const actions: OfferQuoteActions = {
    async quote(input) {
      await pause();
      if (taken.has(input.startsAt)) return fail(offerErrors.slotUnavailable);
      const priced = compute(input);
      if (!priced) return fail(offerErrors.couponRefused);
      const quote: OfferQuote = {
        quoteRef: `q-${(count += 1)}`,
        startsAt: input.startsAt,
        currency: "EUR",
        durationMinutes: 75,
        depositCents: 2000,
        validUntil: new Date(now() + 15 * 60_000).toISOString(),
        baseCents: priced.baseCents,
        optionsCents: priced.optionsCents,
        discountCents: priced.discountCents,
        totalCents: priced.totalCents,
        discountLabel: priced.discountLabel,
        discountSource: priced.discountSource,
      };
      quotes.set(quote.quoteRef, quote);
      quotaKeys.set(quote.quoteRef, priced.quotaKey);
      return { ok: true, data: structuredClone(quote) };
    },
    async confirm({ quoteRef, requestId }) {
      await pause();
      const earlier = receipts.get(requestId);
      if (earlier)
        return earlier.quoteRef === quoteRef
          ? earlier.result
          : fail("idempotency_conflict");
      const quote = quotes.get(quoteRef);
      if (!quote || Date.parse(quote.validUntil) < now())
        return fail(offerErrors.quoteChanged);
      if (taken.has(quote.startsAt)) return fail(offerErrors.slotUnavailable);
      // Never the normal price silently: a used-up offer refuses the quote.
      if (quotaKeys.get(quoteRef)) {
        if (quota <= 0) return fail(offerErrors.offerUnavailable);
        quota -= 1;
      }
      taken.add(quote.startsAt);
      const result = {
        ok: true as const,
        data: {
          bookingId: `b-${receipts.size + 1}`,
          totalCents: quote.totalCents,
        },
      };
      receipts.set(requestId, { quoteRef, result });
      return result;
    },
  };
  return {
    actions,
    /** Someone else uses the last offer meanwhile. */
    useQuota() {
      quota = Math.max(0, quota - 1);
    },
    take(startsAt: string) {
      taken.add(startsAt);
    },
    get bookings() {
      return receipts.size;
    },
  };
}
