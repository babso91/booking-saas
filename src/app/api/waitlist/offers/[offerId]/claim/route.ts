import type { NextRequest } from "next/server";
import { z } from "zod";

import { kickCalendarOutbound } from "@/features/calendar/data/outbound-kick";
import { kickEmailOutbox } from "@/features/notifications/data/kick";
import { claimOffer } from "@/features/waitlist-server/data";
import {
  claimSchema,
  waitlistTokenSchema,
} from "@/features/waitlist-server/schemas";
import { trustedClientIp } from "@/lib/client-identity";
import { AppException, validationException } from "@/lib/errors";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/waitlist/offers/:offerId/claim with `X-Waitlist-Token`
// { requestId, expectedVersion, expectedQuoteRevision } → Offer (`booked`).
// Books through the public booking path; the first commit wins.
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/waitlist/offers/[offerId]/claim">,
) {
  try {
    const clientIp = trustedClientIp(request);
    const { offerId } = await ctx.params;
    const id = z.uuid().safeParse(offerId);
    const token = waitlistTokenSchema.safeParse(
      request.headers.get("x-waitlist-token"),
    );
    if (!id.success || !token.success)
      throw new AppException("waitlist_offer_not_found");
    const parsed = claimSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationException(parsed.error);
    const { offer, appointmentId } = await claimOffer(
      createAdminSupabaseClient() as AppSupabaseClient,
      id.data,
      token.data,
      parsed.data,
      clientIp,
    );
    if (appointmentId) {
      kickCalendarOutbound({ appointmentId });
      kickEmailOutbox({ appointmentId });
    }
    return jsonOk(offer);
  } catch (error) {
    return jsonError(error);
  }
}
