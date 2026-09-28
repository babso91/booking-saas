import "server-only";

import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type BusinessContext = {
  userId: string;
  businessId: string;
  timezone: string;
};

/**
 * Resolves the tenant of the signed-in professional from the session, never
 * from client input. V1 has a single business per professional; the oldest
 * membership wins if several exist.
 *
 * This is a convenience for the DAL: RLS still enforces membership on every
 * query issued with the same client.
 */
export async function getBusinessContext(
  client: AppSupabaseClient,
): Promise<BusinessContext> {
  const { data: userData, error: userError } = await client.auth.getUser();

  if (userError || !userData.user) {
    throw new AppException("unauthenticated", { cause: userError });
  }

  const { data, error } = await client
    .from("business_members")
    .select("business_id, businesses!inner(timezone)")
    .eq("user_id", userData.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw databaseException(error);
  }

  if (!data) {
    throw new AppException("no_business");
  }

  return {
    userId: userData.user.id,
    businessId: data.business_id,
    timezone: data.businesses.timezone,
  };
}
