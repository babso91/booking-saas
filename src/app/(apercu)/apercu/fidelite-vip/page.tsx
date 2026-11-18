import { TiersPreview } from "@/features/loyalty/tiers/tiers-preview";

export const metadata = { title: "Niveaux et parrainage · Aperçu" };

// VIP progression and referral on fictional data, against in-memory
// stand-ins of the contract (docs/LOYALTY_TIERS_CONTRACT.md).
// Like every preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function TiersPreviewPage() {
  return <TiersPreview />;
}
