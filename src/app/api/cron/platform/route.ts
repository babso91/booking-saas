import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET|POST /api/cron/platform — the billing clock: ended cancellations and
// grace periods, scheduled changes that need no payment. Hourly at deploy,
// `Authorization: Bearer $CRON_SECRET`. See docs/PLATFORM_BILLING_CONTRACT.md.
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  const { data, error } = await service.rpc("platform_run_due");
  if (error) {
    console.error("Platform clock failed.");
    return Response.json({ error: "internal" }, { status: 500 });
  }
  return Response.json({ data });
}

export const GET = handle;
export const POST = handle;
