import { runAfterResponse } from "@/features/calendar/data/background";
import { getCalendarDeps } from "@/features/calendar/data/deps";
import { syncCalendar } from "@/features/calendar/data/sync";
import { verifyNotification } from "@/features/calendar/data/webhook";
import { getCalendarEnv } from "@/lib/env/server";

// POST /api/calendar/google/webhook — Google Calendar push notifications.
// A notification only means "something changed": the calendar it designates
// (after verification) is synced from Google after the response. Valid,
// ignored and invalid notifications get the same empty 204, so the endpoint
// reveals nothing to a caller guessing channel ids or tokens.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!getCalendarEnv()) return new Response(null, { status: 204 });

  const deps = getCalendarDeps();
  const calendarId = await verifyNotification(deps, request.headers);
  if (calendarId) {
    runAfterResponse("webhook_sync", () => syncCalendar(deps, calendarId));
  }
  return new Response(null, { status: 204 });
}
