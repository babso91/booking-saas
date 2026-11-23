import "server-only";

import type { AppSupabaseClient } from "@/lib/supabase/types";

import { practicalOf, type EmailPractical } from "../templates/practical";

/**
 * Her published "Infos pratiques" (point 153), read as her site's visitors
 * read it (get_public_site: the published version only). Null without a
 * published site; any other failure is thrown, for the worker to decide.
 */
export async function readEmailPractical(
  client: AppSupabaseClient,
  slug: string,
): Promise<EmailPractical | null> {
  const { data, error } = await client
    .rpc("get_public_site", { p_slug: slug })
    .maybeSingle();
  if (error) {
    if (error.message === "site_not_published") return null;
    throw error;
  }
  return data ? practicalOf(data.config) : null;
}
