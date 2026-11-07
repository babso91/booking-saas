import { runSitePhotoMaintenance } from "@/features/sites/data/photos";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// GET|POST /api/cron/site-photos — the mini-site photos' cleanup
// (docs/SITE_PUBLISHING_CONTRACT.md § 8): abandoned uploads, conversions
// past their deadline, file deletions left by a failure or an interruption
// or run again once the signed upload URLs can no longer write, and the
// bucket's reconciliation with the database. Schedule every 15 minutes at
// deploy, with `Authorization: Bearer $CRON_SECRET`. Answers 500 (after
// doing the rest) when the reconciliation failed.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runSitePhotoMaintenance(
      createAdminSupabaseClient() as AppSupabaseClient,
    );
    if (result.failed > 0) {
      console.error(
        "Site photo cleanup: deletions still failing",
        result.failed,
      );
    }
    const { reconciliation } = result;
    if ("error" in reconciliation) {
      return Response.json(
        { error: "internal", data: result },
        { status: 500 },
      );
    }
    if (!reconciliation.skipped) {
      // Counts only (no names): for the logs' metrics and alerts.
      console.info("Site photo reconciliation", reconciliation);
      if (reconciliation.failed > 0) {
        console.error(
          "Site photo reconciliation: deletions failing",
          reconciliation.failed,
        );
      }
    }
    return Response.json({ data: result });
  } catch (error) {
    console.error("Site photo cleanup failed", error);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
