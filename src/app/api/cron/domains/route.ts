import {
  checkDomain,
  httpsProbe,
  systemResolver,
} from "@/features/domains-server/verifier";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET|POST /api/cron/domains — checks custom domains again (DNS proof,
// certificate and routing; a lost DNS record). Hourly at deploy,
// `Authorization: Bearer $CRON_SECRET`. Without SITE_DOMAIN_TARGET, nothing.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const target = process.env.SITE_DOMAIN_TARGET?.trim().toLowerCase();
  if (!target) return Response.json({ data: { skipped: "not_configured" } });
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  const { data, error } = await service.rpc("site_domains_due", {
    p_limit: 25,
  });
  if (error) return Response.json({ error: "internal" }, { status: 500 });
  let checked = 0;
  for (const row of data) {
    try {
      await checkDomain(
        { service, resolver: systemResolver, probe: httpsProbe, target },
        {
          id: row.domain_id,
          hostname: row.hostname,
          generation: row.generation,
          state: row.state,
          challenge: row.challenge,
        },
      );
      checked += 1;
    } catch {
      console.error("Domain check failed.");
    }
  }
  return Response.json({ data: { checked } });
}

export const GET = handle;
export const POST = handle;
