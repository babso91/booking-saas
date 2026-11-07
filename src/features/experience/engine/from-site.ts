import type { SiteConfig as SavedConfig } from "@/features/sites/config";

import type { SiteConfig } from "./config";

// From the saved configuration (docs/SITE_PUBLISHING_CONTRACT.md § 4, photos
// as { asset }) to what the engine renders: a photo is its asset id, or
// null when there is none to show. The conversion is lossless: every other
// field is the lab's own, unchanged. `unavailable`: assets that can no
// longer be shown (revoked since the version was published, the public
// read's `unavailableAssets`); their places are drawn without a photo.

export function renderConfigOf(
  saved: SavedConfig,
  unavailable: readonly string[] = [],
): SiteConfig {
  const gone = new Set(unavailable);
  const shown = (photo: { asset: string } | null) =>
    photo && !gone.has(photo.asset) ? photo.asset : null;
  return {
    ...saved,
    content: {
      ...saved.content,
      cover: shown(saved.content.cover),
      portrait: {
        ...saved.content.portrait,
        photo: shown(saved.content.portrait.photo),
      },
      // A work keeps its place (its title and note) without its photo.
      works: saved.content.works.map((work) => ({
        ...work,
        photo: shown(work.photo) ?? "",
      })),
    },
  };
}
