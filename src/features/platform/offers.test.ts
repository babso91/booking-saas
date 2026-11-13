import { describe, expect, it } from "vitest";

import { priceOf, savingLabel, type OfferDto } from "./offers";

// The fixture of the brief, in cents: Core 2 900 / 29 000, Signature
// 4 900 / 49 000 (EUR). Prices are provisional; these are test values.
const offers: OfferDto[] = [
  ["core", "month", 2900],
  ["core", "year", 29000],
  ["signature", "month", 4900],
  ["signature", "year", 49000],
].map(([planCode, cadence, amountMinor]) => ({
  planCode: planCode as OfferDto["planCode"],
  cadence: cadence as OfferDto["cadence"],
  amountMinor: amountMinor as number,
  priceVersionId: "v1",
  currency: "EUR",
  displayTaxMode: "ttc",
}));

describe("a plan's price at a cadence", () => {
  it("monthly: charged each month, a year is twelve of them, nothing saved", () => {
    expect(priceOf(offers, "core", "month")).toMatchObject({
      amountMinor: 2900,
      yearlyMinor: 34800,
      monthlyEquivalentMinor: 2900,
      savedPerYearMinor: 0,
    });
  });

  it("yearly: the real total, its month's equivalent, what is saved", () => {
    const view = priceOf(offers, "signature", "year")!;
    expect(view).toMatchObject({
      amountMinor: 49000,
      yearlyMinor: 49000,
      monthlyEquivalentMinor: 4083,
      savedPerYearMinor: 9800,
    });
    expect(savingLabel(view, 4900)).toBe("2 mois offerts");
  });

  it("an offer that is not listed is not invented from another one", () => {
    const monthlyOnly = offers.filter((offer) => offer.cadence === "month");
    expect(priceOf(monthlyOnly, "core", "year")).toBeNull();
  });

  it("a saving that is not whole months has no label; none, no label", () => {
    const odd = offers.map((offer) =>
      offer.planCode === "core" && offer.cadence === "year"
        ? { ...offer, amountMinor: 30000 }
        : offer,
    );
    expect(savingLabel(priceOf(odd, "core", "year")!, 2900)).toBeNull();
    expect(savingLabel(priceOf(offers, "core", "month")!, 2900)).toBeNull();
  });
});
