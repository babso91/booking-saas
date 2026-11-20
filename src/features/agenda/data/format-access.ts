import "server-only";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

/** The same entitlement the site Studio reads. Preferences never grant access. */
export async function hasSignatureAgenda(
  client: AppSupabaseClient,
  businessId: string,
) {
  const { data, error } = await client
    .from("sites")
    .select("plan")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw databaseException(error);
  return data?.plan === "signature";
}
