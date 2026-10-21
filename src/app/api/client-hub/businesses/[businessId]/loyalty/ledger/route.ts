import type { NextRequest } from "next/server";

import { listLedger } from "@/features/client-hub/data/client-hub";
import { withClientHubSession } from "@/features/client-hub/data/route";
import {
  businessIdSchema,
  ledgerQuerySchema,
} from "@/features/client-hub/schemas/client-hub";
import { AppException, validationException } from "@/lib/errors";

// GET /api/client-hub/businesses/:businessId/loyalty/ledger?cursor&limit
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/loyalty/ledger">,
) {
  return withClientHubSession(request, async (admin, token) => {
    const businessId = businessIdSchema.safeParse(
      (await ctx.params).businessId,
    );
    if (!businessId.success) throw new AppException("client_hub_not_found");
    const params = request.nextUrl.searchParams;
    const query = ledgerQuerySchema.safeParse({
      cursor: params.get("cursor") ?? undefined,
      limit: params.get("limit") ?? undefined,
    });
    if (!query.success) throw validationException(query.error);
    return listLedger(admin, token, businessId.data, query.data);
  });
}
