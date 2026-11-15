import { UnsubscribePreview } from "@/features/unsubscribe/unsubscribe-preview";

export const metadata = { title: "Désinscription · Aperçu" };

// The marketing unsubscribe page on fictional links, against an in-memory
// server of the PROPOSED contract (docs/UNSUBSCRIBE_PROPOSAL.md).
// ?lien=tok-a-email|tok-b-sms|faux. Like every preview, a 404 in
// production unless DASHBOARD_PREVIEW=1.
export default async function UnsubscribePreviewPage({
  searchParams,
}: PageProps<"/apercu/desinscription">) {
  const { lien } = await searchParams;
  const token = typeof lien === "string" ? lien : "tok-a-email";
  return <UnsubscribePreview key={token} token={token} />;
}
