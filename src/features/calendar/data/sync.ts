import "server-only";

import {
  CalendarProviderError,
  type CalendarProviderId,
  type ProviderEvent,
} from "@/features/calendar/providers/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";

import { ensureChannel } from "./channels";
import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { withAccessToken } from "./tokens";

// Synchronisation of one blocking calendar into external_calendar_events.
//
// - One worker per calendar (database lease); a request arriving meanwhile
//   makes that worker run once more instead of starting a second one, so 50
//   identical notifications cost at most two passes.
// - Each page is fetched first, then applied in one short transaction under
//   the schedule lock (never a network call while holding it).
// - Full sync: window [now − 1 day, now + 400 days), page by page with the
//   page cursor saved alongside each applied page (an interrupted sync
//   resumes), then a final sweep deletes what was not seen and commits the
//   provider's sync token.
// - Incremental sync: the provider's changes since the token, every page
//   applied, then the new token is committed (re-running the same pages is
//   harmless: applying is idempotent). An invalid token (410) switches to a
//   full sync whose sweep replaces the local copy.
// - Bounded: at most MAX_PAGES pages per pass and a time budget.

const MAX_PAGES = 40; // 40 × 250 events
const MAX_ROUNDS = 3;

export type SyncOutcome =
  | "synced"
  | "busy"
  | "skipped"
  | "too_many_events"
  | "budget_exceeded"
  | "error";

type Claim = {
  claimed: boolean;
  calendarId: string;
  businessId: string;
  connectionId: string;
  provider: CalendarProviderId;
  providerCalendarId: string;
  timezone: string;
  syncToken: string | null;
  windowEnd: string | null;
  fullInProgress: boolean;
  channelId: string | null;
  channelExpiresAt: string | null;
};

class StopSync extends Error {
  constructor(readonly outcome: SyncOutcome) {
    super(outcome);
  }
}

/** Only what PostgreSQL needs to place and qualify an event. */
function toApplied(event: ProviderEvent) {
  return {
    id: event.id,
    recurringEventId: event.recurringEventId,
    status: event.status,
    start: event.start,
    end: event.end,
    transparency: event.transparency,
    eventType: event.eventType,
    declined: event.declined,
    etag: event.etag,
    updated: event.updated,
  };
}

async function rpc<T>(
  promise: PromiseLike<{
    data: T;
    error: { message?: string; code?: string } | null;
  }>,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw databaseException(error);
  return data;
}

async function applyPage(
  deps: CalendarDeps,
  calendarId: string,
  generation: number | null,
  events: ProviderEvent[],
  nextPageToken: string | null,
) {
  const result = (await rpc(
    deps.admin.rpc("calendar_apply_events", {
      p_calendar_id: calendarId,
      // null: incremental page (rows keep the committed generation).
      p_generation: generation as number,
      p_events: events.map(toApplied),
      p_next_page_token: nextPageToken as string,
    }),
  )) as { applied: boolean };
  // Deselected or disconnected meanwhile: stop without touching anything.
  if (!result.applied) throw new StopSync("skipped");
}

async function fullSync(
  deps: CalendarDeps,
  claim: Claim,
  deadline: number,
): Promise<void> {
  const start = (await rpc(
    deps.admin.rpc("calendar_start_full_sync", {
      p_calendar_id: claim.calendarId,
    }),
  )) as {
    generation: number;
    pageToken: string | null;
    windowStart: string;
    windowEnd: string;
  };

  const provider = deps.provider(claim.provider);
  let pageToken = start.pageToken;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Date.now() > deadline) throw new StopSync("budget_exceeded");

    let result;
    try {
      result = await withAccessToken(deps, claim.connectionId, (token) =>
        provider.listEvents(
          token,
          claim.providerCalendarId,
          {
            kind: "full",
            timeMin: new Date(start.windowStart).toISOString(),
            timeMax: new Date(start.windowEnd).toISOString(),
          },
          pageToken,
        ),
      );
    } catch (error) {
      // A resumed page cursor the provider no longer accepts: start over.
      if (
        pageToken &&
        error instanceof CalendarProviderError &&
        (error.kind === "gone" || error.kind === "bad_request")
      ) {
        await rpc(
          deps.admin.rpc("calendar_reset_sync", {
            p_calendar_id: claim.calendarId,
          }),
        );
        return fullSync(deps, { ...claim, fullInProgress: false }, deadline);
      }
      throw error;
    }

    await applyPage(
      deps,
      claim.calendarId,
      start.generation,
      result.events,
      result.nextPageToken,
    );

    if (!result.nextPageToken) {
      const finished = await rpc(
        deps.admin.rpc("calendar_finish_full_sync", {
          p_calendar_id: claim.calendarId,
          p_generation: start.generation,
          p_sync_token: result.nextSyncToken as string,
        }),
      );
      if (!finished) throw new StopSync("skipped");
      return;
    }
    pageToken = result.nextPageToken;
  }

  throw new StopSync("too_many_events");
}

async function incrementalSync(
  deps: CalendarDeps,
  claim: Claim,
  deadline: number,
): Promise<"done" | "gone"> {
  const provider = deps.provider(claim.provider);
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Date.now() > deadline) throw new StopSync("budget_exceeded");

    let result;
    try {
      result = await withAccessToken(deps, claim.connectionId, (token) =>
        provider.listEvents(
          token,
          claim.providerCalendarId,
          { kind: "incremental", syncToken: claim.syncToken! },
          pageToken,
        ),
      );
    } catch (error) {
      if (error instanceof CalendarProviderError && error.kind === "gone") {
        return "gone";
      }
      throw error;
    }

    await applyPage(deps, claim.calendarId, null, result.events, null);

    if (!result.nextPageToken) {
      await rpc(
        deps.admin.rpc("calendar_finish_incremental_sync", {
          p_calendar_id: claim.calendarId,
          p_sync_token: result.nextSyncToken ?? claim.syncToken!,
        }),
      );
      return "done";
    }
    pageToken = result.nextPageToken;
  }

  throw new StopSync("too_many_events");
}

function needsFullSync(claim: Claim) {
  if (!claim.syncToken || claim.fullInProgress || !claim.windowEnd) return true;
  // The window slides: refresh it before it no longer covers 380 days.
  return new Date(claim.windowEnd).getTime() < Date.now() + 380 * 86_400_000;
}

async function syncOnce(
  deps: CalendarDeps,
  claim: Claim,
  deadline: number,
): Promise<void> {
  if (needsFullSync(claim)) {
    await fullSync(deps, claim, deadline);
  } else if ((await incrementalSync(deps, claim, deadline)) === "gone") {
    logCalendar("sync_token_gone", { calendarId: claim.calendarId }, "warn");
    await rpc(
      deps.admin.rpc("calendar_reset_sync", {
        p_calendar_id: claim.calendarId,
      }),
    );
    await fullSync(
      deps,
      { ...claim, syncToken: null, fullInProgress: false },
      deadline,
    );
  }
  await ensureChannel(deps, claim);
}

function errorCode(error: unknown) {
  if (error instanceof StopSync) return error.outcome;
  if (error instanceof AppException) return error.code;
  if (error instanceof CalendarProviderError) return `provider_${error.kind}`;
  return "internal";
}

/**
 * Synchronises one calendar. Never throws: the outcome is returned and
 * recorded on the calendar (sync_status / last_error).
 */
export async function syncCalendar(
  deps: CalendarDeps,
  calendarId: string,
  options: { budgetMs?: number } = {},
): Promise<SyncOutcome> {
  const deadline = Date.now() + (options.budgetMs ?? 25_000);

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const { data, error } = await deps.admin.rpc("calendar_claim_sync", {
      p_calendar_id: calendarId,
      p_lease_seconds: Math.ceil((options.budgetMs ?? 25_000) / 1000) + 30,
    });
    if (error) {
      logCalendar(
        "sync_claim_failed",
        { calendarId, code: error.code },
        "error",
      );
      return "error";
    }
    const claim = data as Claim | null;
    if (!claim) return "skipped";
    if (!claim.claimed) return "busy";

    let failure: string | null = null;
    let outcome: SyncOutcome = "synced";
    try {
      await syncOnce(deps, claim, deadline);
      logCalendar("sync_done", {
        calendarId,
        connectionId: claim.connectionId,
        businessId: claim.businessId,
        provider: claim.provider,
      });
    } catch (error) {
      failure = errorCode(error);
      outcome = error instanceof StopSync ? error.outcome : "error";
      logCalendar(
        "sync_failed",
        {
          calendarId,
          connectionId: claim.connectionId,
          businessId: claim.businessId,
          provider: claim.provider,
          code: failure,
        },
        outcome === "skipped" ? "info" : "warn",
      );
    }

    const again = await rpc(
      deps.admin.rpc("calendar_release_sync", {
        p_calendar_id: calendarId,
        p_error: outcome === "skipped" ? undefined : (failure ?? undefined),
      }),
    ).catch(() => false);

    if (!again || failure || Date.now() > deadline) {
      return outcome === "skipped" ? "skipped" : outcome;
    }
  }
  return "synced";
}
