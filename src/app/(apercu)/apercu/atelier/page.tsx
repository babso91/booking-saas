import { AtelierPreview } from "@/features/atelier/atelier-preview";

export const metadata = { title: "Atelier · Aperçu" };

// The Atelier order, pro side, on fictional data, against an in-memory
// server of the PROPOSED contract (docs/ATELIER_PROPOSAL.md). Nothing is
// billed or published. Like every preview, a 404 in production unless
// DASHBOARD_PREVIEW=1.
export default function AtelierPreviewPage() {
  return <AtelierPreview />;
}
