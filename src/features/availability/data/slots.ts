import "server-only";

import type { AvailabilityQuery } from "@/features/availability/schemas/availability";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type SlotDto = {
  /** UTC instants (ISO 8601). Display them in the business time zone. */
  startsAt: string;
  endsAt: string;
};

/**
 * business + service + local date → slots that can really be booked now.
 *
 * The computation lives in PostgreSQL (`private.available_slots`) and is the
 * very same one the booking transaction re-runs, so the listing can never be
 * more permissive than the insertion. Unknown businesses and inactive or
 * foreign services raise `business_not_found` / `service_not_found`.
 */
export async function getAvailableSlots(
  client: AppSupabaseClient,
  query: AvailabilityQuery,
): Promise<SlotDto[]> {
  const { data, error } = await client.rpc("get_available_slots", {
    p_slug: query.slug,
    p_service_id: query.serviceId,
    p_date: query.date,
  });

  if (error) {
    throw databaseException(error);
  }

  return data.map((slot) => ({
    startsAt: new Date(slot.starts_at).toISOString(),
    endsAt: new Date(slot.ends_at).toISOString(),
  }));
}
