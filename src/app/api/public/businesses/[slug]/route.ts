import type { NextRequest } from "next/server";

import {
  getPublicBusiness,
  listPublicServices,
} from "@/features/businesses/data/public-business";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { AppException, validationException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// GET /api/public/businesses/:slug → public profile and active services.
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/public/businesses/[slug]">,
) {
  try {
    const parsed = businessSlugSchema.safeParse((await ctx.params).slug);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const client = createPublicSupabaseClient();
    const business = await getPublicBusiness(client, parsed.data);

    if (!business) {
      throw new AppException("business_not_found");
    }

    const services = await listPublicServices(client, parsed.data);

    return jsonOk({ business, services });
  } catch (error) {
    return jsonError(error);
  }
}
