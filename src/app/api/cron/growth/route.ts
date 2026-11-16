import { getMarketingTransport } from "@/features/growth-server/transport";
import { runGrowthQueue } from "@/features/growth-server/worker";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { getPublicEnv } from "@/lib/env/public";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET|POST /api/cron/growth — hands the due campaign messages to the
// marketing transport (simulated: nothing really leaves), then reconciles
// uncertain deliveries. Its own queue: appointment emails never wait for
// it. Every few minutes at deploy, `Authorization: Bearer $CRON_SECRET`.
// See docs/GROWTH_CAMPAIGNS_CONTRACT.md.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const data = await runGrowthQueue({
      service: createAdminSupabaseClient() as AppSupabaseClient,
      transport: getMarketingTransport(),
      appUrl: getPublicEnv().NEXT_PUBLIC_APP_URL,
    });
    return Response.json({ data });
  } catch {
    console.error("Growth queue run failed.");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
