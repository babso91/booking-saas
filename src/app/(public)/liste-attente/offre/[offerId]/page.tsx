import type { Metadata } from "next";

import { WaitlistOfferLinkPage } from "@/features/waitlist/link-pages";

// The link of an offer email (docs/WAITLIST_CONTRACT.md). The token is in
// the fragment, read in the browser; the page never sends a referrer.
export const metadata: Metadata = {
  title: "Un créneau s’est libéré",
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function Page({
  params,
}: PageProps<"/liste-attente/offre/[offerId]">) {
  const { offerId } = await params;
  return <WaitlistOfferLinkPage offerId={offerId} />;
}
