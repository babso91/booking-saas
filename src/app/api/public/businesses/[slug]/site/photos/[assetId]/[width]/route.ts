import type { NextRequest } from "next/server";

import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { readPublicSitePhoto } from "@/features/sites/data/photos";
import {
  NO_STORE,
  PUBLIC_PHOTO_CACHE,
  photoNotFound,
  photoResponse,
  sitePhotoCacheTag,
} from "@/features/sites/photos/http";
import { sitePhotoRequestSchema } from "@/features/sites/schemas";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET /api/public/businesses/:slug/site/photos/:assetId/:width — a photo of
// her PUBLISHED site (docs/SITE_PUBLISHING_CONTRACT.md § 8). Checked on
// every request that reaches the server: ready (not revoked), hers, and
// referred to by the version online. Nothing else is served: a draft's
// photo, a revoked one, another business's all answer the same 404.
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/public/businesses/[slug]/site/photos/[assetId]/[width]">,
) {
  const params = await ctx.params;
  const slug = businessSlugSchema.safeParse(params.slug);
  const photo = sitePhotoRequestSchema.safeParse(params);
  if (!slug.success || !photo.success) return photoNotFound();
  try {
    const body = await readPublicSitePhoto(
      createAdminSupabaseClient() as AppSupabaseClient,
      slug.data,
      photo.data.assetId,
      photo.data.width,
    );
    return body
      ? photoResponse(
          body,
          PUBLIC_PHOTO_CACHE,
          sitePhotoCacheTag(photo.data.assetId),
        )
      : photoNotFound();
  } catch (error) {
    console.error("Public site photo failed", error);
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": NO_STORE },
    });
  }
}
