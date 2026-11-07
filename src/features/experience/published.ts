import type { PublishedSiteDto } from "@/features/sites/data/sites";
import { renderedFor } from "@/features/sites/universes";

import type { SiteConfig } from "./engine/config";
import { renderConfigOf } from "./engine/from-site";
import { ensureReadable } from "./engine/harmony";

/**
 * What her clients see of her published version: seen through her CURRENT
 * plan's rights (Core renders a designed palette of her universe with her
 * accent, the universe's composition; Signature, the version as published),
 * its revoked photos drawn without one, then the readability safety net.
 * Nothing here rewrites the version (docs/SITE_PUBLISHING_CONTRACT.md § 3,
 * § 5, § 8).
 */
export function publicView(site: PublishedSiteDto): SiteConfig {
  return ensureReadable(
    renderConfigOf(renderedFor(site.config, site.plan), site.unavailableAssets),
  );
}

/** Where her published photos are served (the public proxy, § 8). */
export const publicPhotoBase = (slug: string) =>
  `/api/public/businesses/${encodeURIComponent(slug)}/site/photos`;
