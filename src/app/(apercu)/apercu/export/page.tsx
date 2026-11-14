import { ExportPreview } from "@/features/crm-export/export-preview";

export const metadata = { title: "Exporter mes clientes · Aperçu" };

// The client-file export on fictional data, against an in-memory server of
// the PROPOSED contract (docs/CRM_EXPORT_PROPOSAL.md). No file is produced.
// Like every preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function ExportPreviewPage() {
  return <ExportPreview />;
}
