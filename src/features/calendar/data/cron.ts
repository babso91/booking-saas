import "server-only";

import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { syncCalendar, type SyncOutcome } from "./sync";

// The periodic job (POST /api/cron/calendar, every 15 minutes at deploy):
// first syncs, sliding windows, channel renewals a day before expiry, retries
// after failures, and a catch-up sync of every calendar not synced for 6
// hours (push notifications are not guaranteed). Bounded per run.

export async function runCalendarJob(
  deps: CalendarDeps,
  options: { budgetMs?: number; limit?: number } = {},
) {
  const deadline = Date.now() + (options.budgetMs ?? 50_000);
  const { data, error } = await deps.admin.rpc("calendar_due_work", {
    p_limit: options.limit ?? 50,
    p_with_channels: Boolean(deps.env.GOOGLE_CALENDAR_WEBHOOK_URL),
  });
  if (error) throw error;

  const results: {
    calendarId: string;
    reason: string;
    outcome: SyncOutcome;
  }[] = [];
  for (const item of data) {
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    results.push({
      calendarId: item.calendar_id,
      reason: item.reason,
      outcome: await syncCalendar(deps, item.calendar_id, {
        budgetMs: Math.min(remaining, 25_000),
      }),
    });
  }
  logCalendar("job_done", { count: results.length });
  return { due: data.length, processed: results };
}
