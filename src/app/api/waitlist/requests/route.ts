import {
  createRequest,
  newWaitlistToken,
} from "@/features/waitlist-server/data";
import { sendConfirmationEmail } from "@/features/waitlist-server/emails";
import { waitlistRequestSchema } from "@/features/waitlist-server/schemas";
import { getEmailTransport } from "@/features/notifications/transport";
import { trustedClientIp } from "@/lib/client-identity";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/waitlist/requests — the request is recorded `pending_confirmation`
// and a confirmation email leaves (double opt-in). Same ingress identity and
// abuse limits as the public booking. A replay sends no second email.
export async function POST(request: Request) {
  try {
    const clientIp = trustedClientIp(request);
    const parsed = waitlistRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationException(parsed.error);

    const token = newWaitlistToken();
    const created = await createRequest(
      createAdminSupabaseClient() as AppSupabaseClient,
      parsed.data,
      clientIp,
      token,
    );
    if (!created.replayed) {
      const configured = getEmailTransport();
      if (configured) {
        try {
          await sendConfirmationEmail(configured, {
            requestId: created.id,
            to: created.email!,
            firstName: created.firstName!,
            businessName: created.businessName!,
            token,
          });
        } catch {
          // The request stays pending; she can ask again (new requestId).
          console.error("Waitlist confirmation email failed");
        }
      }
    }
    return jsonOk(
      {
        id: created.id,
        state: created.state,
        activeUntil: created.activeUntil,
      },
      { status: created.replayed ? 200 : 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
