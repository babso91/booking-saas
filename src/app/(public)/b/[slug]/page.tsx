import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { getPublicBusiness } from "@/features/businesses/data/public-business";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { getPublicCatalog } from "@/features/catalog/data/catalog";
import { showcaseOf } from "@/features/experience/catalog/model";
import { siteFontClasses } from "@/features/experience/fonts";
import { MiniSite } from "@/features/experience/mini-site";
import { publicPhotoBase, publicView } from "@/features/experience/published";
import { PublicBooking } from "@/features/public-booking/components/public-booking";
import { getPublishedSite } from "@/features/sites/data/sites";
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
  return { business, catalog, site };
});

export async function generateMetadata({
  params,
}: PageProps<"/b/[slug]">): Promise<Metadata> {
  const page = await readPublicPage((await params).slug);
  return {
    title: page
      ? page.site
        ? page.business.name
        : `Réserver chez ${page.business.name}`
      : "Réservation",
    robots: { index: false },
  };
}

export default async function PublicBookingPage({
  params,
}: PageProps<"/b/[slug]">) {
  const page = await readPublicPage((await params).slug);
  if (!page) notFound();

  if (page.site)
    return (
      <MiniSite
        config={publicView(page.site)}
        catalog={showcaseOf(page.catalog)}
        photoBase={publicPhotoBase(page.business.slug)}
        // The same booking as her booking page: her catalogue, options
        // included, priced and timed by the server.
        booking={{ business: page.business, catalog: page.catalog }}
        fontClasses={siteFontClasses}
      />
    );

  return <PublicBooking business={page.business} catalog={page.catalog} />;
}
