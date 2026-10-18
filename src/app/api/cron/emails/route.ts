import { getEmailWorkerDeps } from "@/features/notifications/data/deps";
import { logEmail } from "@/features/notifications/data/log";
import { runEmailOutbox } from "@/features/notifications/data/worker";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

// GET|POST /api/cron/emails — delivers the due transactional emails
// (confirmations, reminders, changes, cancellations). Schedule every 5
// minutes at deploy, with `Authorization: Bearer $CRON_SECRET`. Without an
// email transport (EMAIL_TRANSPORT), nothing is claimed: the outbox keeps
// every email. See docs/NOTIFICATIONS_CONTRACT.md.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const deps = getEmailWorkerDeps();
  if (!deps) {
    return Response.json({ data: { skipped: "not_configured" } });
  }
  try {
    const result = await runEmailOutbox(deps);
    logEmail("run", { transport: deps.transport.name, count: result.sent });
    return Response.json({ data: result });
  } catch {
    logEmail("run_failed", { transport: deps.transport.name }, "error");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
