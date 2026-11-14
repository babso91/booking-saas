import { CampaignPreview } from "@/features/growth/campaign-preview";

export const metadata = { title: "Relance · Aperçu" };

// A rebooking or reactivation campaign on fictional clients, against an
// in-memory server of the PROPOSED contract
// (docs/GROWTH_CAMPAIGNS_PROPOSAL.md). Nothing is ever sent. Like every
// preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function CampaignPreviewPage() {
  return <CampaignPreview />;
}
