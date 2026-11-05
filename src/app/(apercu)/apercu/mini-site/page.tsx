import { showcaseOf } from "@/features/experience/catalog/model";
import {
  sampleCatalog,
  sampleSite,
  sampleWorks,
} from "@/features/experience/fixtures/sample-sites";
import { siteFontClasses } from "@/features/experience/fonts";
import { MiniSite } from "@/features/experience/mini-site";
import { publicView } from "@/features/experience/published";
import type { SitePlan } from "@/features/sites/data/sites";
import type { UniverseId } from "@/features/sites/universes";

export const metadata = { title: "Mini-site · Aperçu" };

// The real mini-site (engine, scenes, public view) on a fictional site and
// catalogue, without database: to review the universes WITHOUT photos, as
// a professional's site is before she adds hers. No booking is taken
// here: "Réserver" says so (never a fake booking journey). Like every
// preview, a 404 in production unless DASHBOARD_PREVIEW=1.
// ?univers=mila|alma|nail-lab, ?forfait=core|signature,
// ?oeuvres=1 (a gallery whose photos were all withdrawn).
const UNIVERSES: UniverseId[] = ["mila", "alma", "nail-lab"];

export default async function MiniSitePreviewPage({
  searchParams,
}: PageProps<"/apercu/mini-site">) {
  const { univers, forfait, oeuvres } = await searchParams;
  const universe = UNIVERSES.includes(univers as UniverseId)
    ? (univers as UniverseId)
    : "mila";
  const plan: SitePlan = forfait === "core" ? "core" : "signature";
  const saved = sampleSite(universe);
  const withdrawn = sampleWorks(universe).map(
    (work, index) =>
      ({
        id: `w${index + 1}`,
        photo: { asset: `00000000-0000-4000-8000-00000000000${index + 1}` },
        ...work,
      }) as const,
  );
  const config =
    oeuvres === "1"
      ? { ...saved, content: { ...saved.content, works: withdrawn } }
      : saved;
  return (
    <MiniSite
      config={publicView({
        versionId: "apercu",
        number: 1,
        publishedAt: "2026-11-05T10:00:00.000Z",
        plan,
        schemaVersion: 1,
        config,
        unavailableAssets: withdrawn.map((work) => work.photo.asset),
      })}
      catalog={showcaseOf(sampleCatalog)}
      photoBase="/apercu-sans-photo"
      // A design preview: no booking is ever taken here.
      booking={null}
      fontClasses={siteFontClasses}
    />
  );
}
