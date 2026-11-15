import { ReviewPreview } from "@/features/forms/review/review-preview";

export const metadata = { title: "Formulaires de la visite · Aperçu" };

// The forms of a visit, pro side, on fictional data, against an in-memory
// server of the PROPOSED contract (docs/CLIENT_FORMS_PROPOSAL.md, "Côté
// pro"). Like every preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function ReviewPreviewPage() {
  return <ReviewPreview />;
}
