import { PlanChangePreview } from "@/features/plan-change/plan-change-preview";

export const metadata = { title: "Changer de formule · Aperçu" };

// The plan change on provisional prices, against an in-memory server of
// the PROPOSED contract (docs/PLAN_CHANGE_PROPOSAL.md). Nothing is ever
// charged. Like every preview, a 404 in production unless
// DASHBOARD_PREVIEW=1.
export default function PlanChangePreviewPage() {
  return <PlanChangePreview />;
}
