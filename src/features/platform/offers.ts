// Her subscription offers (M7). PROPOSED contract
// (docs/PLATFORM_OFFERS_PROPOSAL.md): no server lists offers yet, and no
// subscription can be taken online. What the screens may show for real
// today is her current plan (sites.plan, the server's) and what it allows
// (the Studio's own lens, features/experience/studio/plans.ts).
//
// Prices are commercial decisions, versioned and configurable: never
// written in a component. Amounts are integers in minor units.

export type PlanCode = "core" | "signature";
export type Cadence = "month" | "year";

export type OfferDto = {
  planCode: PlanCode;
  /** The commercial version this price belongs to. */
  priceVersionId: string;
  cadence: Cadence;
  amountMinor: number;
  currency: string;
  /** Whether the amount includes taxes, said next to it. */
  displayTaxMode: "ttc" | "ht";
};

export type OffersDto = { offers: OfferDto[]; catalogRevision: string };

/** One plan at one cadence, as she would pay it. */
export type PriceView = {
  /** Charged each period. */
  amountMinor: number;
  cadence: Cadence;
  /** What a year costs at this cadence. */
  yearlyMinor: number;
  /** A month's equivalent, rounded down to the cent. */
  monthlyEquivalentMinor: number;
  /** Saved over a year against paying monthly; 0 when none or unknown. */
  savedPerYearMinor: number;
  currency: string;
  displayTaxMode: OfferDto["displayTaxMode"];
};

/**
 * The price of a plan at a cadence, from the offers as listed. Null when
 * that plan has no offer at that cadence: nothing is computed from another
 * one (an annual price is never derived from a monthly one).
 */
export function priceOf(
  offers: OfferDto[],
  plan: PlanCode,
  cadence: Cadence,
): PriceView | null {
  const offer = offers.find(
    (item) => item.planCode === plan && item.cadence === cadence,
  );
  if (!offer) return null;
  const yearly =
    cadence === "year" ? offer.amountMinor : offer.amountMinor * 12;
  const monthly = offers.find(
    (item) =>
      item.planCode === plan &&
      item.cadence === "month" &&
      item.currency === offer.currency,
  );
  return {
    amountMinor: offer.amountMinor,
    cadence,
    yearlyMinor: yearly,
    monthlyEquivalentMinor: Math.floor(yearly / 12),
    savedPerYearMinor:
      cadence === "year" && monthly
        ? Math.max(0, monthly.amountMinor * 12 - offer.amountMinor)
        : 0,
    currency: offer.currency,
    displayTaxMode: offer.displayTaxMode,
  };
}

/** « 2 mois offerts » when the saving is a whole number of months. */
export function savingLabel(
  view: PriceView,
  monthlyMinor: number | null,
): string | null {
  if (view.savedPerYearMinor <= 0) return null;
  if (monthlyMinor && view.savedPerYearMinor % monthlyMinor === 0) {
    const months = view.savedPerYearMinor / monthlyMinor;
    return `${months} mois offert${months > 1 ? "s" : ""}`;
  }
  return null;
}
