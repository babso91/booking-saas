import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { publicReviews } from "@/features/reviews/data";
import { AppException } from "@/lib/errors";
import { jsonOk, jsonError } from "@/lib/http";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/public/businesses/[slug]/reviews">,
) {
  try {
    const slug = businessSlugSchema.safeParse((await ctx.params).slug);
    const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
    if (
      !slug.success ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 2147483647
    )
      throw new AppException("validation_error");
    return jsonOk(
      await publicReviews(createPublicSupabaseClient(), slug.data, offset),
    );
  } catch (error) {
    return jsonError(error);
  }
}
