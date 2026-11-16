import type { Metadata } from "next";

import { UnsubscribeLinkPage } from "@/features/unsubscribe/unsubscribe-link-page";

// The link of a marketing message (docs/MARKETING_CONSENT_CONTRACT.md). The
// token is in the fragment, read in the browser; no referrer is ever sent.
export const metadata: Metadata = {
  title: "Ne plus recevoir d’offres",
  robots: { index: false },
  referrer: "no-referrer",
};

export default function Page() {
  return <UnsubscribeLinkPage />;
}
