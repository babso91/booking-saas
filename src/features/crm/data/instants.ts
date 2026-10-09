import "server-only";

import type { BusinessInstantDto } from "@/features/crm/types";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { readBusinessTime } from "@/lib/time/business-time";

/**
 * Wall clocks of the instants of one response, from the calendar authority
 * (public.business_time, members only) in one round trip: never from this
 * server's or the browser's time zone database.
 */
export async function businessInstants(
  client: AppSupabaseClient,
  businessId: string,
  instants: (string | null | undefined)[],
) {
  const present = instants.filter((value): value is string => Boolean(value));
  const time = await readBusinessTime(client, businessId, {
    instants: present,
  });

  const at = (value: string): BusinessInstantDto => {
    const wall = time.wall(value);
    return {
      at: new Date(value).toISOString(),
      local: wall.local,
      occurrence: wall.occurrence,
    };
  };

  return {
    at,
    optional: (value: string | null | undefined) => (value ? at(value) : null),
    /** The database's instant of this answer. */
    now: time.now,
  };
}
