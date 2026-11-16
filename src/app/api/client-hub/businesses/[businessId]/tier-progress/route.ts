import type { NextRequest } from "next/server";

import { withClientHubSession } from "@/features/client-hub/data/route";
import { businessIdSchema } from "@/features/client-hub/schemas/client-hub";
import { getHubTierProgress } from "@/features/loyalty/growth/data";
import { AppException } from "@/lib/errors";

// GET /api/client-hub/businesses/:businessId/tier-progress — her VIP tier
// (docs/LOYALTY_TIERS_CONTRACT.md).
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/tier-progress">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const businessId = businessIdSchema.safeParse(
      (await ctx.params).businessId,
    );
    if (!businessId.success) throw new AppException("client_hub_not_found");
    return getHubTierProgress(admin, token, businessId.data);
  });
}
