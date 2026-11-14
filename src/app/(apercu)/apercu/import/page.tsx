import { ImportPreview } from "@/features/crm-import/import-preview";

export const metadata = { title: "Importer mes clientes · Aperçu" };

// The contact import wizard on fictional clients, against an in-memory
// server of the PROPOSED contract (docs/CRM_IMPORT_PROPOSAL.md). Nothing is
// written. Like every preview, a 404 in production unless
// DASHBOARD_PREVIEW=1.
export default function ImportPreviewPage() {
  return <ImportPreview />;
}
