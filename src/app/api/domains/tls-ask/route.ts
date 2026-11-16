import { domainRoutingEnabled } from "@/features/domains-server/config";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET /api/domains/tls-ask?domain=<name> — the certificate server's "ask"
// before issuing on demand (Caddy on_demand_tls): 200 only for a name whose
// proof was seen, 404 otherwise, and always 404 while routing by name is off
// (a certificate must never serve the whole application on her name). No
// certificate is requested from here.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!domainRoutingEnabled()) return new Response(null, { status: 404 });
  const domain = new URL(request.url).searchParams.get("domain") ?? "";
  if (!domain || domain.length > 253)
    return new Response(null, { status: 404 });
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  const { data, error } = await service.rpc("site_domain_tls_allowed", {
    p_hostname: domain,
  });
  return new Response(null, { status: !error && data === true ? 200 : 404 });
}
