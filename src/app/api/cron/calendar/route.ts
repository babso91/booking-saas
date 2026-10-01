import { timingSafeEqual } from "node:crypto";

import { runCalendarJob } from "@/features/calendar/data/cron";
import { getCalendarDeps } from "@/features/calendar/data/deps";
import { getCalendarEnv, getCronSecret } from "@/lib/env/server";

// GET|POST /api/cron/calendar — periodic calendar job (schedule every 15
// minutes at deploy, with `Authorization: Bearer $CRON_SECRET`). See
// docs/CALENDAR_INTEGRATION_CONTRACT.md.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = getCronSecret();
  const header = request.headers.get("authorization") ?? "";
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!getCalendarEnv()) {
    return Response.json({ data: { skipped: "not_configured" } });
  }
  const result = await runCalendarJob(getCalendarDeps());
  return Response.json({
    data: { due: result.due, processed: result.processed.length },
  });
}

export const GET = handle;
export const POST = handle;
