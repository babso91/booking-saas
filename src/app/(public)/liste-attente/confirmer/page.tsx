import type { Metadata } from "next";

import { WaitlistConfirmPage } from "@/features/waitlist/link-pages";

// The link of her confirmation email (docs/WAITLIST_CONTRACT.md). The token
// is in the fragment, read in the browser; the page never sends a referrer.
export const metadata: Metadata = {
  title: "Liste d’attente",
  robots: { index: false },
  referrer: "no-referrer",
};

export default function Page() {
  return <WaitlistConfirmPage />;
}
