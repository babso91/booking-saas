import "server-only";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// What a newly onboarded professional still has to configure before the
// agenda is useful: at least one bookable service and opening hours. Read
// with the user's client (RLS) and scoped to the session's business.

export type SetupProgressDto = {
  /** Active services (an inactive one cannot be booked). */
  activeServices: number;
  /** Weekly opening ranges (none: every day is closed). */
  openingRanges: number;
};

export async function getSetupProgress(
  client: AppSupabaseClient,
  businessId: string,
): Promise<SetupProgressDto> {
  const [services, hours] = await Promise.all([
    client
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("active", true),
    client
      .from("business_hours")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId),
  ]);

  if (services.error) throw databaseException(services.error);
  if (hours.error) throw databaseException(hours.error);

  return {
    activeServices: services.count ?? 0,
    openingRanges: hours.count ?? 0,
  };
}

/** Whether the services and the hours are both configured. */
export const setupComplete = (progress: SetupProgressDto) =>
  progress.activeServices > 0 && progress.openingRanges > 0;
