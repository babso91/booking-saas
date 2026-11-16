import "server-only";

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// What a custom name serves (the proxy, the probe): its business's public
// page slug, for a name whose proof was seen. Kept a minute per name; the
// oldest entries go first when full, and unknown names have their own,
// smaller store (random Host headers never push the known ones out).

export type DomainRoute = { domainId: string; slug: string } | null;

const TTL_MS = 60_000;
const MAX_KNOWN = 5_000;
const MAX_UNKNOWN = 1_000;
const known = new Map<string, { route: DomainRoute; until: number }>();
const unknown = new Map<string, number>();

function remember<T>(
  store: Map<string, T>,
  key: string,
  value: T,
  max: number,
) {
  store.delete(key);
  store.set(key, value);
  if (store.size > max) store.delete(store.keys().next().value!);
}

/** The name as a client may send it: lower case, no port, no final dot. */
export function canonicalHost(host: string) {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export async function routeForHost(hostname: string): Promise<DomainRoute> {
  const host = canonicalHost(hostname);
  const now = Date.now();
  const hit = known.get(host);
  if (hit && hit.until > now) return hit.route;
  const miss = unknown.get(host);
  if (miss && miss > now) return null;
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  const { data, error } = await service.rpc("site_domain_route", {
    p_hostname: host,
  });
  if (error) return null;
  const row = data[0];
  if (!row) {
    remember(unknown, host, now + TTL_MS, MAX_UNKNOWN);
    return null;
  }
  const route = { domainId: row.domain_id, slug: row.slug };
  remember(known, host, { route, until: now + TTL_MS }, MAX_KNOWN);
  return route;
}
