import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";
import { kickCalendarOutbound } from "@/features/calendar/data/outbound-kick";
import { requestBookingConsent } from "@/features/marketing-consent/data";
import { claimReferral } from "@/features/loyalty/growth/data";
import { kickEmailOutbox } from "@/features/notifications/data/kick";
import { validationException } from "@/lib/errors";
import { trustedClientIp } from "@/lib/client-identity";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/bookings — public booking, no client account required.
// Body: { slug, serviceId, startsAt, firstName, lastName?, email, phone?,
//         requestId, marketingConsent?, referralCode? }
// 201 → booking summary (200 with `replayed: true` for a retried request);
// 409 slot_unavailable when the slot was taken meanwhile; 429 rate_limited;
// 503 booking_unavailable when the trusted ingress gave no client address.
export async function POST(request: Request) {
  try {
    // First: no identity from the trusted ingress, no booking.
    const clientIp = trustedClientIp(request);
    const parsed = createPublicBookingSchema.safeParse(
      await readJsonBody(request),
    );

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    // The booking function is executable by the service role only: this
    // route is the one entry, and the address it passes (established by the
    // trusted ingress) cannot be skipped with the publishable key.
    const service = createAdminSupabaseClient() as AppSupabaseClient;
    const booking = await createPublicBooking(service, parsed.data, clientIp);

    // A referral link's code: claimed once for this booking (a retry says
    // the same). It never fails nor changes the booking; nothing about the
    // referrer is answered.
    if (parsed.data.referralCode) {
      try {
        await claimReferral(
          service,
          parsed.data.referralCode,
          booking.appointmentId,
        );
      } catch {
        console.error("Referral claim failed.");
      }
    }

    // Her marketing choices, after the booking: they never fail nor change
    // it. Her ticked boxes wait for her confirmation from the link sent to
    // her address (double opt-in): a booking proves no mailbox.
    const marketingConsent = parsed.data.marketingConsent
      ? await requestBookingConsent(
          service,
          booking.appointmentId,
          parsed.data.marketingConsent,
        )
      : undefined;

    // The Google mirror and the confirmation email never delay nor fail the
    // booking: they run after the response, from the committed state.
    if (!booking.replayed) {
      kickCalendarOutbound({ appointmentId: booking.appointmentId });
      kickEmailOutbox({ appointmentId: booking.appointmentId });
    }

    return jsonOk(
      marketingConsent ? { booking, marketingConsent } : { booking },
      { status: booking.replayed ? 200 : 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
