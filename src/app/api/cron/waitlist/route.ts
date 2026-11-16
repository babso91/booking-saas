import { getEmailTransport } from "@/features/notifications/transport";
import { matchReleases } from "@/features/waitlist-server/data";
import { sendOfferEmail } from "@/features/waitlist-server/emails";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Scheduled: reads freed capacity, creates offers (FIFO, no hold) and emails
// them. Without a transport nothing is offered: an offer nobody can see would
// only block the next request.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const configured = getEmailTransport();
  if (!configured) {
    return Response.json({ data: { skipped: "not_configured" } });
  }
  try {
    const result = await matchReleases(
      createAdminSupabaseClient() as AppSupabaseClient,
    );
    let sent = 0;
    for (const offer of result.offers) {
      try {
        await sendOfferEmail(configured, offer);
        sent += 1;
      } catch {
        console.error("Waitlist offer email failed", offer.offerId);
      }
    }
    return Response.json({
      data: { signals: result.signals, offers: result.offers.length, sent },
    });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
