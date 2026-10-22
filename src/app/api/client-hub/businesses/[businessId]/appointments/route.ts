import type { NextRequest } from "next/server";

import { listAppointments } from "@/features/client-hub/data/client-hub";
import { withClientHubSession } from "@/features/client-hub/data/route";
import {
  appointmentsQuerySchema,
  businessIdSchema,
} from "@/features/client-hub/schemas/client-hub";
import { AppException, validationException } from "@/lib/errors";

// GET /api/client-hub/businesses/:businessId/appointments
//   ?scope=upcoming|past&cursor&limit (1–50, default 20)
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/appointments">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const businessId = businessIdSchema.safeParse(
      (await ctx.params).businessId,
    );
    if (!businessId.success) throw new AppException("client_hub_not_found");
    const params = request.nextUrl.searchParams;
    const query = appointmentsQuerySchema.safeParse({
      scope: params.get("scope") ?? undefined,
      cursor: params.get("cursor") ?? undefined,
      limit: params.get("limit") ?? undefined,
    });
    if (!query.success) throw validationException(query.error);
    return listAppointments(admin, token, businessId.data, query.data);
  });
}
