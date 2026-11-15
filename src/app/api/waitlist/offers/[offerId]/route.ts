import type { NextRequest } from "next/server";
import { z } from "zod";

import { readOffer } from "@/features/waitlist-server/data";
import { waitlistTokenSchema } from "@/features/waitlist-server/schemas";
import { AppException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET /api/waitlist/offers/:offerId with `X-Waitlist-Token` (the fragment of
// the offer link) → Offer. Reads only; a wrong id or token is one 404.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/waitlist/offers/[offerId]">,
) {
  try {
    const { offerId } = await ctx.params;
    const id = z.uuid().safeParse(offerId);
    const token = waitlistTokenSchema.safeParse(
      request.headers.get("x-waitlist-token"),
    );
    if (!id.success || !token.success)
      throw new AppException("waitlist_offer_not_found");
    return jsonOk(
      await readOffer(
        createAdminSupabaseClient() as AppSupabaseClient,
        id.data,
        token.data,
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}
