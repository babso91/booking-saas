import "server-only";

import type { BusinessInstantDto } from "@/features/crm/types";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { readBusinessTime } from "@/lib/time/business-time";

/**
 * Wall clocks of the instants of one response, from the calendar authority
 * (public.business_time, members only) in one round trip: never from this
 * server's or the browser's time zone database.
 *
 * `timezone` is the zone that very call converted with (read by
 * business_time itself), the one a response must advertise: never a zone
 * read earlier (the session's business context), which a concurrent change
 * could make disagree with the wall clocks. Called once per response, with
 * every instant of it, even when there is none (empty page): one zone.
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
    /** The zone of every wall clock above. */
    timezone: time.timezone,
    /** The database's instant of this answer. */
    now: time.now,
  };
}
