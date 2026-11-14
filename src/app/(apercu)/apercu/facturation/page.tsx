import {
  BillingPreview,
  type BillingScenario,
} from "@/features/billing/billing-preview";

export const metadata = { title: "Facturation · Aperçu" };

const SCENARIOS: BillingScenario[] = ["actif", "impaye", "termine"];

// Her subscription and invoices on fictional data, against an in-memory
// server of the PROPOSED contract (docs/BILLING_SUMMARY_PROPOSAL.md).
// ?etat=actif|impaye|termine. No provider, no charge. Like every preview,
// a 404 in production unless DASHBOARD_PREVIEW=1.
export default async function BillingPreviewPage({
  searchParams,
}: PageProps<"/apercu/facturation">) {
  const { etat } = await searchParams;
  const scenario = SCENARIOS.includes(etat as BillingScenario)
    ? (etat as BillingScenario)
    : "actif";
  return <BillingPreview key={scenario} scenario={scenario} />;
}
