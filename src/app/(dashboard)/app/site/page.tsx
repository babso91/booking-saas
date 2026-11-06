import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { getPublicCatalog } from "@/features/catalog/data/catalog";
import {
  areaIdentityKey,
  areaIdentityOf,
} from "@/features/dashboard/area-identity";
import { showcaseOf } from "@/features/experience/catalog/model";
import { siteFontClasses } from "@/features/experience/fonts";
import { SiteStudio } from "@/features/experience/studio/site-studio";
import { listSitePhotos } from "@/features/sites/data/photos";
import { getSite, getSiteVersion } from "@/features/sites/data/sites";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Mon site",
};

// Her studio (docs/SITE_PUBLISHING_CONTRACT.md): her draft, her version
// online, her photos, read as a member (RLS); her catalogue as her clients
// see it. Full screen: the preview is her site.
export default async function SiteStudioPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();
  const client = await createServerSupabaseClient();
  const [site, catalog, photos] = await Promise.all([
    getSite(client, business.id),
    getPublicCatalog(client, business.slug),
    listSitePhotos(client, business.id),
  ]);
  const online = site?.published
    ? await getSiteVersion(client, business.id, site.published.versionId)
    : null;

  return (
    <SiteStudio
      // One studio per identity: nothing typed or read for one business
      // is ever shown, kept or saved under another.
      key={areaIdentityKey(areaIdentityOf({ user, business }))}
      site={site}
      // A business without a site yet is on Core until told otherwise.
      plan={site?.plan ?? "core"}
      online={
        online
          ? {
              config: online.config,
              number: online.number,
              publishedAt: online.publishedAt,
            }
          : null
      }
      catalog={catalog ? showcaseOf(catalog) : []}
      businessName={business.name}
      businessId={business.id}
      photos={photos.map((photo) => ({ id: photo.id, status: photo.status }))}
      fontClasses={siteFontClasses}
    />
  );
}
