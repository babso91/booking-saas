import type { NextRequest } from "next/server";

import { getAppointment } from "@/features/client-hub/data/client-hub";
import { withClientHubSession } from "@/features/client-hub/data/route";
import {
  appointmentIdSchema,
  businessIdSchema,
} from "@/features/client-hub/schemas/client-hub";
import { AppException } from "@/lib/errors";

// GET /api/client-hub/businesses/:businessId/appointments/:appointmentId
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/appointments/[appointmentId]">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const params = await ctx.params;
    const businessId = businessIdSchema.safeParse(params.businessId);
    const appointmentId = appointmentIdSchema.safeParse(params.appointmentId);
    if (!businessId.success || !appointmentId.success) {
      throw new AppException("client_hub_not_found");
    }
    return getAppointment(admin, token, businessId.data, appointmentId.data);
  });
}
