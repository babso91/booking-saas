import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { getPublicBusiness } from "@/features/businesses/data/public-business";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { getPublicCatalog } from "@/features/catalog/data/catalog";
import { PublicBooking } from "@/features/public-booking/components/public-booking";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// The public booking page of one business. Its profile and its catalogue
// are read like GET /api/public/businesses/:slug does (same public RPCs,
// session-less, nothing private): categories, bookable services and their
// options, as get_public_catalog projects them. Availability, quotes and
// booking go through the public routes from the browser.
const readPublicPage = cache(async (slug: string) => {
  const parsed = businessSlugSchema.safeParse(slug);
  if (!parsed.success) return null;
  const client = createPublicSupabaseClient();
  const business = await getPublicBusiness(client, parsed.data);
  if (!business) return null;
  const catalog = await getPublicCatalog(client, parsed.data);
  if (!catalog) return null;
  return { business, catalog };
});

export async function generateMetadata({
  params,
}: PageProps<"/b/[slug]">): Promise<Metadata> {
  const page = await readPublicPage((await params).slug);
  return {
    title: page ? `Réserver chez ${page.business.name}` : "Réservation",
    robots: { index: false },
  };
}

export default async function PublicBookingPage({
  params,
}: PageProps<"/b/[slug]">) {
  const page = await readPublicPage((await params).slug);
  if (!page) notFound();

  return <PublicBooking business={page.business} catalog={page.catalog} />;
}
