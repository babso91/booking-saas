import type { NextRequest } from "next/server";

import { rescheduleAppointment } from "@/features/client-hub/data/appointment-actions";
import {
  assertSameOrigin,
  withClientHubSession,
} from "@/features/client-hub/data/route";
import { rescheduleAppointmentSchema } from "@/features/client-hub/schemas/appointment-actions";
import {
  appointmentIdSchema,
  businessIdSchema,
} from "@/features/client-hub/schemas/client-hub";
import { AppException, validationException } from "@/lib/errors";
import { readJsonBody } from "@/lib/http";

// POST /api/client-hub/businesses/:businessId/appointments/:appointmentId/reschedule
// → the appointment detail after the change. Same origin, JSON only. A
// refusal changes nothing.
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/appointments/[appointmentId]/reschedule">,
) {
  return withClientHubSession(request, async (admin, token) => {
    assertSameOrigin(request, true);
    const params = await ctx.params;
    const businessId = businessIdSchema.safeParse(params.businessId);
    const appointmentId = appointmentIdSchema.safeParse(params.appointmentId);
    if (!businessId.success || !appointmentId.success) {
      throw new AppException("client_hub_not_found");
    }
    const parsed = rescheduleAppointmentSchema.safeParse(
      await readJsonBody(request),
    );
    if (!parsed.success) throw validationException(parsed.error);
    return rescheduleAppointment(
      admin,
      token,
      businessId.data,
      appointmentId.data,
      parsed.data,
    );
  });
}
