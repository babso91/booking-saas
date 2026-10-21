import type { NextRequest } from "next/server";

import { getLoyalty } from "@/features/client-hub/data/client-hub";
import { withClientHubSession } from "@/features/client-hub/data/route";
import { businessIdSchema } from "@/features/client-hub/schemas/client-hub";
import { AppException } from "@/lib/errors";

// GET /api/client-hub/businesses/:businessId/loyalty
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/loyalty">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const businessId = businessIdSchema.safeParse(
      (await ctx.params).businessId,
    );
    if (!businessId.success) throw new AppException("client_hub_not_found");
    return getLoyalty(admin, token, businessId.data);
  });
}
