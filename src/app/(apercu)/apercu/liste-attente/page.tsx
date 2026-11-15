import { WaitlistPreview } from "@/features/waitlist/waitlist-preview";

export const metadata = { title: "Liste d’attente · Aperçu" };

// The waitlist's screens against an in-memory server of the PROPOSED
// contract (docs/WAITLIST_PROPOSAL.md). Like every preview, a 404 in
// production unless DASHBOARD_PREVIEW=1.
// ?ecran=inscription (default) | offre ; ?pris=1: someone books first.
export default async function WaitlistPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ecran, pris } = await searchParams;
  return (
    <WaitlistPreview
      screen={ecran === "offre" ? "offre" : "inscription"}
      taken={pris === "1"}
    />
  );
}
