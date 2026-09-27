import "server-only";

import type { CreatePublicBookingInput } from "@/features/appointments/schemas/public-booking";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type PublicBookingDto = {
  appointmentId: string;
  /** UTC instants (ISO 8601). */
  startsAt: string;
  endsAt: string;
  timezone: string;
  serviceName: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  businessName: string;
};

/**
 * Creates a public booking through `public.create_public_booking`, a single
 * transaction that re-validates the slot, finds or creates the client within
 * the business, inserts the appointment and queues the confirmation email.
 * Double booking is ultimately prevented by the `appointments_no_overlap`
 * exclusion constraint and surfaces as `slot_unavailable`.
 */
export async function createPublicBooking(
  client: AppSupabaseClient,
  input: CreatePublicBookingInput,
): Promise<PublicBookingDto> {
  const { data, error } = await client.rpc("create_public_booking", {
    p_slug: input.slug,
    p_service_id: input.serviceId,
    p_starts_at: input.startsAt,
    p_first_name: input.firstName,
    p_email: input.email,
    p_last_name: input.lastName,
    p_phone: input.phone,
  });

  if (error) {
    throw databaseException(error);
  }

  const row = data[0];

  if (!row) {
    throw new AppException("internal", { message: "Booking returned no row." });
  }

  return {
    appointmentId: row.appointment_id,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    timezone: row.timezone,
    serviceName: row.service_name,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
    currency: row.currency,
    businessName: row.business_name,
  };
}
