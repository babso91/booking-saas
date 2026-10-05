import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";
import { kickCalendarOutbound } from "@/features/calendar/data/outbound-kick";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// POST /api/bookings — public booking, no client account required.
// Body: { slug, serviceId, startsAt, firstName, lastName?, email, phone? }
// 201 → booking summary; 409 slot_unavailable when the slot was taken meanwhile.
export async function POST(request: Request) {
  try {
    const parsed = createPublicBookingSchema.safeParse(
      await readJsonBody(request),
    );

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const booking = await createPublicBooking(
      createPublicSupabaseClient(),
      parsed.data,
    );

    // The Google mirror never delays nor fails the booking: it runs after
    // the response, from the committed desired state.
    kickCalendarOutbound({ appointmentId: booking.appointmentId });

    return jsonOk({ booking }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
