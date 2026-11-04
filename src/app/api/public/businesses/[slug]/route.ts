import type { NextRequest } from "next/server";

import {
  getPublicBusiness,
  listPublicServices,
} from "@/features/businesses/data/public-business";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { getPublicCatalog } from "@/features/catalog/data/catalog";
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

    const [services, catalog] = await Promise.all([
      listPublicServices(client, parsed.data),
      getPublicCatalog(client, parsed.data),
    ]);

    // `services`: the former flat list, unchanged for existing clients.
    // `catalog`: categories, services and options, as the mini-site shows them.
    return jsonOk({ business, services, catalog });
  } catch (error) {
    return jsonError(error);
  }
}
