import { ConsentPreview } from "@/features/marketing-consent/consent-preview";

export const metadata = { title: "Consentement · Aperçu" };

// The marketing consent's foundation, for review: the question and the
// history, on fictional data. The wording is a proposal: nothing collects
// it anywhere else. Like every preview, a 404 in production unless
// DASHBOARD_PREVIEW=1.
export default function ConsentPreviewPage() {
  return <ConsentPreview />;
}
