import "server-only";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type PublicBusinessDto = {
  slug: string;
  name: string;
  description: string | null;
  location: string | null;
  logoPath: string | null;
  timezone: string;
  cancellationPolicy: string | null;
  currency: string;
  slotIntervalMinutes: number;
  minimumBookingNoticeMinutes: number;
  maximumBookingAdvanceDays: number;
};

export type PublicServiceDto = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  currency: string;
};

export async function getPublicBusiness(
  client: AppSupabaseClient,
  slug: string,
): Promise<PublicBusinessDto | null> {
  const { data, error } = await client.rpc("get_public_business", {
    p_slug: slug,
  });

  if (error) {
    throw databaseException(error);
  }

  const row = data[0];

  if (!row) {
    return null;
  }

  return {
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    location: row.location ?? null,
    logoPath: row.logo_path ?? null,
    timezone: row.timezone,
    cancellationPolicy: row.cancellation_policy ?? null,
    currency: row.currency,
    slotIntervalMinutes: row.slot_interval_minutes,
    minimumBookingNoticeMinutes: row.minimum_booking_notice_minutes,
    maximumBookingAdvanceDays: row.maximum_booking_advance_days,
  };
}

/** Active services only, in display order. Inactive services never leave the database. */
export async function listPublicServices(
  client: AppSupabaseClient,
  slug: string,
): Promise<PublicServiceDto[]> {
  const { data, error } = await client.rpc("get_public_services", {
    p_slug: slug,
  });

  if (error) {
    throw databaseException(error);
  }

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
    currency: row.currency,
  }));
}
