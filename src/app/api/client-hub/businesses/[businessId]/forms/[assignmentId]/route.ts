import type { NextRequest } from "next/server";

import { hubForm } from "@/features/client-forms/data/forms";
import { assignmentIdSchema } from "@/features/client-forms/schemas";
import { withClientHubSession } from "@/features/client-hub/data/route";
import { businessIdSchema } from "@/features/client-hub/schemas/client-hub";
import { AppException } from "@/lib/errors";

// GET /api/client-hub/businesses/:businessId/forms/:assignmentId → ClientFormDto.
// No access, another client or another business: the same opaque 404.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/forms/[assignmentId]">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const params = await ctx.params;
    const businessId = businessIdSchema.safeParse(params.businessId);
    const assignmentId = assignmentIdSchema.safeParse(params.assignmentId);
    if (!businessId.success || !assignmentId.success) {
      throw new AppException("client_hub_not_found");
    }
    return hubForm(admin, token, businessId.data, assignmentId.data);
  });
}
