import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  getPublicBusiness,
  listPublicServices,
} from "@/features/businesses/data/public-business";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { PublicBooking } from "@/features/public-booking/components/public-booking";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// The public booking page of one business. Its profile and active services
// are read like GET /api/public/businesses/:slug does (same public RPCs,
// session-less, nothing private); availability and booking go through the
// public routes from the browser.
const readPublicPage = cache(async (slug: string) => {
  const parsed = businessSlugSchema.safeParse(slug);
  if (!parsed.success) return null;
  const client = createPublicSupabaseClient();
  const business = await getPublicBusiness(client, parsed.data);
  if (!business) return null;
  const services = await listPublicServices(client, parsed.data);
  return { business, services };
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

  return <PublicBooking business={page.business} services={page.services} />;
}
