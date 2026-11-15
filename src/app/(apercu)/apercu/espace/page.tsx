import { HubPreview } from "@/features/client-hub/preview/hub-preview";

export const metadata = { title: "Mon espace · Aperçu" };

// The Client Hub's appointment page on fictional data, with her own
// changes (cancel, move) answered by an in-browser stand-in of the
// PROPOSED routes: to review the screens before the backend exists. Like
// every preview, a 404 in production unless DASHBOARD_PREVIEW=1.
// ?etat=ouvert (default) | ferme (deadline passed) | sans (today's server).
export default async function HubPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { etat } = await searchParams;
  return (
    <HubPreview
      scenario={
        etat === "ferme" ? "ferme" : etat === "sans" ? "sans" : "ouvert"
      }
    />
  );
}
