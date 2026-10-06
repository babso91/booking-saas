import "server-only";

import { withDeadline } from "@/features/calendar/providers/http";

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
// Fairness between the two directions: each one has a real deadline, not
// only checks of the time between two operations. Inbound (lists and syncs)
// ends at INBOUND_SHARE of the run's budget, whatever it is waiting for: its
// signal is aborted, the job stops waiting (a late answer or failure is
// still consumed, never an unhandled rejection) and outbound starts with
// what is left, at least the rest of the budget. Outbound ends at the run's
// deadline the same way, and only runs after inbound, so it can never take
// inbound's share either. A database call abandoned this way may still
// complete: every inbound and outbound write is a claim or a
// compare-and-set in SQL, harmless when it lands late.

/** Share of a run's budget inbound may use; outbound keeps the rest. */
export const INBOUND_SHARE = 0.6;

type InboundRun = {
  due: number;
  processed: { calendarId: string; reason: string; outcome: SyncOutcome }[];
};

/** A database call aborted with `signal`; never started once it is aborted. */
function abortable<T extends { abortSignal(signal: AbortSignal): T }>(
  query: T,
  signal: AbortSignal | undefined,
) {
  return signal ? query.abortSignal(signal) : query;
}

async function runInbound(
  deps: CalendarDeps,
  run: InboundRun,
  deadline: number,
  signal: AbortSignal | undefined,
  limit: number,
) {
  const stop = (margin: number) =>
    signal?.aborted === true || deadline - Date.now() < margin;

  const { data: lists } = await abortable(
    deps.admin.rpc("calendar_due_calendar_lists", { p_limit: 20 }),
    signal,
  );
  for (const { connection_id: connectionId } of lists ?? []) {
    if (stop(5000)) break;
    // Stamped only now, when it is really read (6 hours until the next
    // attempt, whatever the outcome); one left unread stays due.
    const { data: started } = await abortable(
      deps.admin.rpc("calendar_begin_calendar_list_check", {
        p_connection_id: connectionId,
      }),
      signal,
    );
    if (!started) continue;
    await refreshConnectionCalendars(deps, connectionId, {
      deadline: Math.min(deadline, Date.now() + 15_000),
    }).catch(() =>
      logCalendar("calendar_list_retry_failed", { connectionId }, "warn"),
    );
  }

  const { data, error } = await abortable(
    deps.admin.rpc("calendar_due_work", {
      p_limit: limit,
      p_with_channels: Boolean(deps.env.GOOGLE_CALENDAR_WEBHOOK_URL),
    }),
    signal,
  );
  if (error) throw error;
  run.due = data.length;

  for (const item of data) {
    if (stop(2000)) break;
    const outcome = await syncCalendar(deps, item.calendar_id, {
      budgetMs: Math.min(deadline - Date.now(), 25_000),
    });
    run.processed.push({
      calendarId: item.calendar_id,
      reason: item.reason,
      outcome,
    });
  }
}

export async function runCalendarJob(
  deps: CalendarDeps,
  options: { budgetMs?: number; limit?: number } = {},
) {
  const budget = options.budgetMs ?? 50_000;
  const start = Date.now();
  const deadline = start + budget;
  const inboundDeadline = start + Math.floor(budget * INBOUND_SHARE);

  const inbound: InboundRun = { due: 0, processed: [] };
  let inboundFailure: unknown = null;
  let inboundSignal: AbortSignal | undefined;
  await withDeadline(inboundDeadline, (signal) => {
    inboundSignal = signal;
    return runInbound(
      deps,
      inbound,
      inboundDeadline,
      signal,
      options.limit ?? 50,
    );
  }).catch((error: unknown) => {
    // Its deadline is known by its signal (aborted before the rejection),
    // never by the clock alone: a timer may fire a millisecond before
    // Date.now() reaches the deadline.
    if (inboundSignal?.aborted || Date.now() >= inboundDeadline) {
      // Abandoned at its deadline: outbound keeps its share.
      logCalendar("inbound_deadline_exceeded", {}, "warn");
    } else {
      // Reported once outbound has had its turn.
      inboundFailure = error;
    }
  });
  // What inbound did within its share (a pass still running in the
  // background is not reported).
  const processed = [...inbound.processed];

  let outbound: OutboundRunResult | null = null;
  // Outbound's own slice: at least (1 - INBOUND_SHARE) of the budget.
  const left = deadline - Date.now();
  if (left > 2000) {
    outbound = await withDeadline(deadline, (signal) =>
      processOutbound(deps, { budgetMs: left - 500, signal }),
    ).catch(() => {
      logCalendar("outbound_job_failed", {}, "error");
      return null;
    });
  }
  if (inboundFailure) throw inboundFailure;
  logCalendar("job_done", { count: processed.length });
  return { due: inbound.due, processed, outbound };
}
