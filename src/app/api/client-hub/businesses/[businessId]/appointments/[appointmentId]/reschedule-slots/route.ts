import type { NextRequest } from "next/server";

import { rescheduleSlots } from "@/features/client-hub/data/appointment-actions";
import { withClientHubSession } from "@/features/client-hub/data/route";
import { rescheduleSlotsQuerySchema } from "@/features/client-hub/schemas/appointment-actions";
import {
  appointmentIdSchema,
  businessIdSchema,
} from "@/features/client-hub/schemas/client-hub";
import { AppException, validationException } from "@/lib/errors";

// GET …/appointments/:appointmentId/reschedule-slots?date=YYYY-MM-DD (local
// day of the business) → { date, timezone, slots }. Informative only: the
// move checks again. Empty when moving is not allowed.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/appointments/[appointmentId]/reschedule-slots">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const params = await ctx.params;
    const businessId = businessIdSchema.safeParse(params.businessId);
    const appointmentId = appointmentIdSchema.safeParse(params.appointmentId);
    if (!businessId.success || !appointmentId.success) {
      throw new AppException("client_hub_not_found");
    }
    const query = rescheduleSlotsQuerySchema.safeParse({
      date: request.nextUrl.searchParams.get("date"),
    });
    if (!query.success) throw validationException(query.error);
    return rescheduleSlots(
      admin,
      token,
      businessId.data,
      appointmentId.data,
      query.data.date,
    );
  });
}
