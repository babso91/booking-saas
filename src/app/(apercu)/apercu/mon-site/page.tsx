import { showcaseOf } from "@/features/experience/catalog/model";
import { sampleCatalog } from "@/features/experience/fixtures/sample-sites";
import { siteFontClasses } from "@/features/experience/fonts";
import { StudioPreview } from "@/features/experience/studio/studio-preview";

export const metadata = { title: "Mon site · Aperçu" };

// Her real studio on an in-memory server (memory-actions.ts), without
// database nor bucket: to review it and test its states. Like every
// preview, a 404 in production unless DASHBOARD_PREVIEW=1, and its preview
// never takes a booking.
// ?forfait=core|signature, ?publie=1 (a version online), ?conflit=1
// (another tab saves first), ?photo=<error code> (every upload fails).
export default async function SiteStudioPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { forfait, publie, conflit, photo } = await searchParams;
  return (
    <StudioPreview
      plan={forfait === "core" ? "core" : "signature"}
      published={publie === "1"}
      conflict={conflit === "1"}
      photoError={typeof photo === "string" ? photo : undefined}
      catalog={showcaseOf(sampleCatalog)}
      fontClasses={siteFontClasses}
    />
  );
}
