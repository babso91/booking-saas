import "server-only";

import { refreshConnectionCalendars } from "./connection";
import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { processOutbound, type OutboundRunResult } from "./outbound";
import { syncCalendar, type SyncOutcome } from "./sync";

// The periodic job (POST /api/cron/calendar, every 15 minutes at deploy):
// first syncs, sliding windows, channel renewals a day before expiry, retries
// after failures, and a catch-up sync of every calendar not synced for 6
// hours (push notifications are not guaranteed). Bounded per run.
// First, the calendar lists of connections holding untrusted calendars are
// read again (at most every 6 hours per connection): a known zone coming
// back restores trust, and the calendar is then fully synced in this run.
// Last, outbound: dedicated calendars to create and due mirrors (durable
// catch-up of what the background kicks did not apply).
//
// Fairness between the two directions: inbound (lists and syncs) has at
// most INBOUND_SHARE of the run's budget, so slow syncs can never consume
// what outbound needs; outbound only gets what is left after inbound, so it
// can never starve inbound either. Both progress at every run.

/** Share of a run's budget inbound may use; outbound keeps the rest. */
export const INBOUND_SHARE = 0.6;

export async function runCalendarJob(
  deps: CalendarDeps,
  options: { budgetMs?: number; limit?: number } = {},
) {
  const budget = options.budgetMs ?? 50_000;
  const start = Date.now();
  const deadline = start + budget;
  const inboundDeadline = start + Math.floor(budget * INBOUND_SHARE);

  const { data: lists } = await deps.admin.rpc("calendar_due_calendar_lists", {
    p_limit: 20,
  });
  for (const { connection_id: connectionId } of lists ?? []) {
    if (inboundDeadline - Date.now() < 5000) break;
    // Stamped only now, when it is really read (6 hours until the next
    // attempt, whatever the outcome); one left unread stays due.
    const { data: started } = await deps.admin.rpc(
      "calendar_begin_calendar_list_check",
      { p_connection_id: connectionId },
    );
    if (!started) continue;
    await refreshConnectionCalendars(deps, connectionId, {
      deadline: Math.min(inboundDeadline, Date.now() + 15_000),
    }).catch(() =>
      logCalendar("calendar_list_retry_failed", { connectionId }, "warn"),
    );
  }

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
    const remaining = inboundDeadline - Date.now();
    if (remaining < 2000) break;
    results.push({
      calendarId: item.calendar_id,
      reason: item.reason,
      outcome: await syncCalendar(deps, item.calendar_id, {
        budgetMs: Math.min(remaining, 25_000),
      }),
    });
  }
  let outbound: OutboundRunResult | null = null;
  // Outbound's own slice: at least (1 - INBOUND_SHARE) of the budget.
  const left = deadline - Date.now();
  if (left > 2000) {
    outbound = await processOutbound(deps, { budgetMs: left - 500 }).catch(
      () => {
        logCalendar("outbound_job_failed", {}, "error");
        return null;
      },
    );
  }
  logCalendar("job_done", { count: results.length });
  return { due: data.length, processed: results, outbound };
}
