import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";
import { kickCalendarOutbound } from "@/features/calendar/data/outbound-kick";
import { validationException } from "@/lib/errors";
import { clientKeyOf, jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/bookings — public booking, no client account required.
// Body: { slug, serviceId, startsAt, firstName, lastName?, email, phone?,
//         requestId }
// 201 → booking summary (200 with `replayed: true` for a retried request);
// 409 slot_unavailable when the slot was taken meanwhile; 429 rate_limited.
export async function POST(request: Request) {
  try {
    const parsed = createPublicBookingSchema.safeParse(
      await readJsonBody(request),
    );

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    // The booking function is executable by the service role only: this
    // route is the one entry, and the client key it passes cannot be
    // skipped by calling the RPC with the publishable key.
    const booking = await createPublicBooking(
      createAdminSupabaseClient() as AppSupabaseClient,
      parsed.data,
      clientKeyOf(request),
    );

    // The Google mirror never delays nor fails the booking: it runs after
    // the response, from the committed desired state.
    if (!booking.replayed) {
      kickCalendarOutbound({ appointmentId: booking.appointmentId });
    }

    return jsonOk({ booking }, { status: booking.replayed ? 200 : 201 });
  } catch (error) {
    return jsonError(error);
  }
}
