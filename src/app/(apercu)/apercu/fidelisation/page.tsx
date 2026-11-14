import { RetentionPreview } from "@/features/retention/retention-preview";

export const metadata = { title: "Fidélisation · Aperçu" };

// How many new clients come back, on fictional figures, against an
// in-memory server of the PROPOSED report (docs/RETENTION_REPORT_PROPOSAL.md).
// Like every preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function RetentionPreviewPage() {
  return <RetentionPreview />;
}
