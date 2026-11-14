import { QuotePreview } from "@/features/offers/quote-preview";

export const metadata = { title: "Devis du créneau · Aperçu" };

// The slot's exact quote with an offer or a code, on fictional data,
// against an in-memory server of the PROPOSED contract
// (docs/OFFER_QUOTE_PROPOSAL.md). Nothing is booked or charged. Like every
// preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function QuotePreviewPage() {
  return <QuotePreview />;
}
