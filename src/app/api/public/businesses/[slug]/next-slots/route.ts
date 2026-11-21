import type { NextRequest } from "next/server";

import { getNextSlots } from "@/features/availability/data/slots";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// GET /api/public/businesses/:slug/next-slots → the next bookable slot of
// each service bookable online (Higani point 2), earliest first:
// { services: [{ serviceId, slot: SlotDto | null }] }. The general « next
// availability » is the first entry's slot.
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/public/businesses/[slug]/next-slots">,
) {
  try {
    const parsed = businessSlugSchema.safeParse((await ctx.params).slug);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const services = await getNextSlots(
      createPublicSupabaseClient(),
      parsed.data,
    );
    return jsonOk({ services });
  } catch (error) {
    return jsonError(error);
  }
}
