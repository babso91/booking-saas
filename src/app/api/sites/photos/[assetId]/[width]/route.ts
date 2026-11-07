import type { NextRequest } from "next/server";

import { getBusinessContext } from "@/features/businesses/data/business-context";
import { readMemberSitePhoto } from "@/features/sites/data/photos";
import {
  PRIVATE_PHOTO_CACHE,
  photoNotFound,
  photoResponse,
} from "@/features/sites/photos/http";
import { sitePhotoRequestSchema } from "@/features/sites/schemas";
import { AppException } from "@/lib/errors";
import { jsonError } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET /api/sites/photos/:assetId/:width — her studio's preview of one of
// HER ready photos, published or not (docs/SITE_PUBLISHING_CONTRACT.md § 8).
// Her session decides the business; never cached by anything shared.
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/sites/photos/[assetId]/[width]">,
) {
  try {
    const client = await createServerSupabaseClient();
    const { businessId, userId } = await getBusinessContext(client);
    const photo = sitePhotoRequestSchema.safeParse(await ctx.params);
    if (!photo.success) return photoNotFound();
    const body = await readMemberSitePhoto(
      {
        service: createAdminSupabaseClient() as AppSupabaseClient,
        businessId,
        actor: userId,
      },
      photo.data.assetId,
      photo.data.width,
    );
    return body ? photoResponse(body, PRIVATE_PHOTO_CACHE) : photoNotFound();
  } catch (error) {
    // Signed out, no business, refused: JSON, never stored.
    return jsonError(
      error instanceof AppException
        ? error
        : new AppException("internal", { cause: error }),
    );
  }
}
