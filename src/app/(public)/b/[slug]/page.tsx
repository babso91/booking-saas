import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  getPublicBusiness,
  getPublicBusinessHours,
} from "@/features/businesses/data/public-business";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { getPublicCatalog } from "@/features/catalog/data/catalog";
import { showcaseOf } from "@/features/experience/catalog/model";
import { siteFontClasses } from "@/features/experience/fonts";
import { MiniSite } from "@/features/experience/mini-site";
import { publicPhotoBase, publicView } from "@/features/experience/published";
import {
  jsonForScript,
  localBusinessData,
  shareDescription,
} from "@/features/experience/share";
import { PublicBooking } from "@/features/public-booking/components/public-booking";
import { getPublishedSite } from "@/features/sites/data/sites";
import { publicSitesIndexable } from "@/lib/env/server";
import { AppException } from "@/lib/errors";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// The public page of one business. Its profile and its catalogue are read
// like GET /api/public/businesses/:slug does (same public RPCs,
// session-less, nothing private): categories, bookable services and their
// options, as get_public_catalog projects them. Availability, quotes and
// booking go through the public routes from the browser.
//
// With a published mini-site: her site, as her clients see it (publicView),
// with the same catalogue and the same booking (options included). Without
// one: the booking page, as before. A draft is never read here.
const readPublicPage = cache(async (slug: string) => {
  const parsed = businessSlugSchema.safeParse(slug);
  if (!parsed.success) return null;
  const client = createPublicSupabaseClient();
  const business = await getPublicBusiness(client, parsed.data);
  if (!business) return null;
  const [catalog, site] = await Promise.all([
    getPublicCatalog(client, parsed.data),
    getPublishedSite(client, parsed.data).catch((error: unknown) => {
      if (error instanceof AppException && error.code === "site_not_published")
        return null;
      throw error;
    }),
  ]);
  if (!catalog) return null;
  // Her usual hours, for her site's "Infos pratiques" only.
  const hours = site ? await getPublicBusinessHours(client, parsed.data) : [];
  return { business, catalog, site, hours };
});

/** The app's origin, read at run time (one build, several origins). */
function appOrigin() {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
  } catch {
    return undefined;
  }
}

/** Her page in a shared link and a search engine (Higani 26, 27). */
function shareOf(
  page: NonNullable<Awaited<ReturnType<typeof readPublicPage>>>,
) {
  const { business, site } = page;
  const config = site ? publicView(site) : null;
  // The name her site shows (her Studio's), else her business's.
  const name = config?.brand.name.trim() || business.name;
  return {
    config,
    name,
    // Her name alone: her page is hers, not the product's.
    title: config ? name : `Réserver chez ${name}`,
    description: shareDescription({
      name,
      config,
      description: business.description,
      location: business.location,
    }),
    path: `/b/${business.slug}`,
  };
}

export async function generateMetadata({
  params,
}: PageProps<"/b/[slug]">): Promise<Metadata> {
  const page = await readPublicPage((await params).slug);
  if (!page) return { title: "Réservation", robots: { index: false } };
  const { config, name, title, description, path } = shareOf(page);
  return {
    metadataBase: appOrigin(),
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    // The image is opengraph-image.tsx, next to this page.
    openGraph: {
      type: "website",
      locale: "fr_FR",
      url: path,
      siteName: name,
      title,
      description,
    },
    twitter: { card: "summary_large_image", title, description },
    // Only a site she published, and only where indexing is turned on.
    robots: { index: Boolean(config) && publicSitesIndexable() },
  };
}

export default async function PublicBookingPage({
  params,
}: PageProps<"/b/[slug]">) {
  const page = await readPublicPage((await params).slug);
  if (!page) notFound();

  const { config, name, description, path } = shareOf(page);
  if (config) {
    const origin = appOrigin()?.origin ?? "";
    const cover = config.content.cover;
    const data = localBusinessData({
      name,
      description,
      url: `${origin}${path}`,
      // Her cover as her public photos serve it (none: no image).
      image: cover
        ? `${origin}${publicPhotoBase(page.business.slug)}/${cover}/1200`
        : undefined,
      config,
      hours: page.hours,
    });
    return (
      <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonForScript(data) }}
        />
        <MiniSite
          config={config}
          catalog={showcaseOf(page.catalog)}
          photoBase={publicPhotoBase(page.business.slug)}
          // The same booking as her booking page: her catalogue, options
          // included, priced and timed by the server.
          booking={{ business: page.business, catalog: page.catalog }}
          hours={page.hours}
          fontClasses={siteFontClasses}
        />
      </>
    );
  }

  return <PublicBooking business={page.business} catalog={page.catalog} />;
}
