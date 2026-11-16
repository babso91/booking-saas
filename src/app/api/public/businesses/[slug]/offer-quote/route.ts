import type { NextRequest } from "next/server";

import { getOfferQuote } from "@/features/offers-server/data";
import { offerQuoteSchema } from "@/features/offers-server/schemas";
import { trustedClientIp } from "@/lib/client-identity";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk, readJsonBody } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// POST /api/public/businesses/:slug/offer-quote — the exact price of one
// slot with these answers, with a code or the best automatic offer
// (docs/OFFER_QUOTE_CONTRACT.md). Reserves and consumes nothing.
// Body: { serviceId, optionChoiceIds, startsAt, coupon? } → OfferQuote.
// 422 coupon_refused (one generic answer); 409 slot_unavailable;
// 429 rate_limited (refused codes per network); 503 booking_unavailable
// without the trusted ingress identity.
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/public/businesses/[slug]/offer-quote">,
) {
  try {
    const clientIp = trustedClientIp(request);
    const body = (await readJsonBody(request)) as Record<
      string,
      unknown
    > | null;
    const parsed = offerQuoteSchema.safeParse({
      ...(body ?? {}),
      slug: (await ctx.params).slug,
    });
    if (!parsed.success) throw validationException(parsed.error);
    return jsonOk(
      await getOfferQuote(
        createAdminSupabaseClient() as AppSupabaseClient,
        parsed.data,
        clientIp,
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}
