import "server-only";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { databaseException } from "@/lib/supabase/errors";
import { AppException } from "@/lib/errors";
import type { ReviewPage } from "./model";

export async function publicReviews(
  client: AppSupabaseClient,
  slug: string,
  offset = 0,
) {
  const { data, error } = await client.rpc("get_public_business_reviews", {
    p_slug: slug,
    p_offset: offset,
  });
  if (error) throw databaseException(error);
  if (!data) throw new AppException("business_not_found");
  return data as unknown as ReviewPage;
}
