import type { NextRequest } from "next/server";

import {
  assertSameOrigin,
  withClientHubSession,
} from "@/features/client-hub/data/route";
import { businessIdSchema } from "@/features/client-hub/schemas/client-hub";
import {
  createReferralLink,
  getReferralLink,
} from "@/features/loyalty/growth/data";
import { createReferralLinkSchema } from "@/features/loyalty/growth/schemas";
import { AppException, validationException } from "@/lib/errors";
import { readJsonBody } from "@/lib/http";

// Her referral link (docs/LOYALTY_TIERS_CONTRACT.md). She shares it
// herself: nothing is ever sent to anyone from here.
//   GET  → ReferralLinkDto | null (her current link, active or expired)
//   POST { requestId } → ReferralLinkDto (a new link; the previous one
//        stops working); 409 referral_unavailable without a referral offer.

type Ctx = RouteContext<"/api/client-hub/businesses/[businessId]/referral">;

async function businessIdOf(ctx: Ctx) {
  const parsed = businessIdSchema.safeParse((await ctx.params).businessId);
  if (!parsed.success) throw new AppException("client_hub_not_found");
  return parsed.data;
}

export async function GET(request: NextRequest, ctx: Ctx) {
  return withClientHubSession(request, async (admin, token) =>
    getReferralLink(admin, token, await businessIdOf(ctx)),
  );
}

export async function POST(request: NextRequest, ctx: Ctx) {
  return withClientHubSession(request, async (admin, token) => {
    assertSameOrigin(request, true);
    const body = createReferralLinkSchema.safeParse(
      await readJsonBody(request),
    );
    if (!body.success) throw validationException(body.error);
    return createReferralLink(
      admin,
      token,
      await businessIdOf(ctx),
      body.data.requestId,
    );
  });
}
