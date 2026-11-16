import type { NextRequest } from "next/server";

import { hubForms } from "@/features/client-forms/data/forms";
import { withClientHubSession } from "@/features/client-hub/data/route";
import { businessIdSchema } from "@/features/client-hub/schemas/client-hub";
import { AppException } from "@/lib/errors";

// GET /api/client-hub/businesses/:businessId/forms — the forms asked of her
// in this business (withdrawn ones are left out).
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/forms">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const params = await ctx.params;
    const businessId = businessIdSchema.safeParse(params.businessId);
    if (!businessId.success) throw new AppException("client_hub_not_found");
    return hubForms(admin, token, businessId.data);
  });
}
