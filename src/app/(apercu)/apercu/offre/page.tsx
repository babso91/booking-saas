import type { OfferDto } from "@/features/platform/offers";
import { PlanOverview } from "@/features/platform/plan-overview";

export const metadata = { title: "Mon offre · Aperçu" };

// Her offer page with a listed catalogue of offers: fictional, the values
// of the brief (provisional, not a commercial decision). Like every
// preview, a 404 in production unless DASHBOARD_PREVIEW=1.
// ?forfait=core|signature.
const offers: OfferDto[] = (
  [
    ["core", "month", 2900],
    ["core", "year", 29000],
    ["signature", "month", 4900],
    ["signature", "year", 49000],
  ] as const
).map(([planCode, cadence, amountMinor]) => ({
  planCode,
  cadence,
  amountMinor,
  priceVersionId: "apercu",
  currency: "EUR",
  displayTaxMode: "ttc",
}));

export default async function PlanPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { forfait } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-4xl px-4 pt-8 pb-16 sm:px-6">
      <PlanOverview
        current={forfait === "signature" ? "signature" : "core"}
        offers={offers}
      />
    </main>
  );
}
