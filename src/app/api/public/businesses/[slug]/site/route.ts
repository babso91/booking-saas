import type { NextRequest } from "next/server";

import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { getPublishedSite } from "@/features/sites/data/sites";
import { validationException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// GET /api/public/businesses/:slug/site — her published site only (never the
// draft), with her current plan: the renderer applies its rights, then the
// readability net (docs/SITE_PUBLISHING_CONTRACT.md § 3, § 5).
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/public/businesses/[slug]/site">,
) {
  try {
    const parsed = businessSlugSchema.safeParse((await ctx.params).slug);
    if (!parsed.success) throw validationException(parsed.error);
    const site = await getPublishedSite(
      createPublicSupabaseClient(),
      parsed.data,
    );
    return jsonOk({ site });
  } catch (error) {
    return jsonError(error);
  }
}
