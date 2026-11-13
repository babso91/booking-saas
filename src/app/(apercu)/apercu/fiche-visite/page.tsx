import { VisitPreview } from "@/features/crm/visit-notes/visit-preview";

export const metadata = { title: "Fiche de visite · Aperçu" };

// "Préparer la visite" and the visit's technical sheet on fictional data,
// against an in-memory server of the PROPOSED contract
// (docs/CRM_VISIT_NOTES_PROPOSAL.md). Like every preview, a 404 in
// production unless DASHBOARD_PREVIEW=1.
export default function VisitPreviewPage() {
  return <VisitPreview />;
}
