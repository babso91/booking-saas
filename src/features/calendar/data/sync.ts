import "server-only";

import {
  CalendarProviderError,
  type CalendarProviderId,
  type EventQuery,
  type ProviderEventPage,
  type ProviderEvent,
} from "@/features/calendar/providers/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";

import { ensureChannel, stopChannels } from "./channels";
import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { StaleCredentialsError, withAccessToken } from "./tokens";

// Synchronisation of one blocking calendar into external_calendar_events.
//
// - Authority: a pass works for one claim (calendar_claim_sync returns a
//   claim id). Every write of the pass (page, cursor, finish, reset,
//   channel, release) is conditional on that claim in SQL; a worker whose
//   claim was taken over (expired lease), revoked (reconnection,
//   disconnection, deselection, time zone change) writes nothing. Provider
//   calls use the credentials of the incarnation the claim was issued for.
// - One global deadline per pass: every provider call (refresh included)
//   gets the remaining time, never more, so a pass ends before its lease.
// - Each page is fetched first, then applied in one short transaction under
//   the schedule lock (never a network call while holding it).
// - Full sync: window [now − 1 day, now + 400 days), page by page with the
//   page cursor saved alongside each applied page; an interrupted sync
//   resumes its own attempt (same generation) only while it continues its
//   pagination; any restart from page 1 gets a new generation. The final
//   page carries the cursor; the sweep then deletes every older generation.
// - Incremental sync: the provider's changes since the cursor, every page
//   applied, then the new cursor is committed (re-running the same pages is
//   harmless: applying is idempotent). An invalid cursor (410), more than
//   MAX_PAGES pages or a calendar time zone change switch to a full sync
//   with a new generation.
// - A calendar beyond MAX_PAGES pages in a full sync is `incomplete`: the
//   previous copy plus what was read keeps blocking, nothing is swept, the
//   next pass resumes the pagination. A partial copy is never `synced`.

const MAX_PAGES = 40; // 40 × 250 events
const MAX_ROUNDS = 3;
/** Restarts of a full sync within a pass (time zone change, lost cursor). */
const MAX_RESTARTS = 2;

export type SyncOutcome =
  | "synced"
  /** Another worker holds the calendar (it will run once more). */
  | "busy"
  /** Not selected or not connected (nothing to do). */
  | "skipped"
  /** The claim or the credentials were replaced: nothing was written. */
  | "superseded"
  /** Beyond the bounded sync: copy kept, not swept. */
  | "incomplete"
  /** Time budget exceeded: copy kept, resumed by the next pass. */
  | "stale"
  | "error";

type Claim = {
  claimed: boolean;
  claimId: string;
  calendarId: string;
  businessId: string;
  connectionId: string;
  connectionGeneration: string;
  provider: CalendarProviderId;
  providerCalendarId: string;
  timezone: string;
  syncToken: string | null;
  windowEnd: string | null;
  fullInProgress: boolean;
  channelId: string | null;
  channelExpiresAt: string | null;
};

/** One sync pass: its claim, its deadline and the cursor it committed. */
export type SyncPass = {
  deps: CalendarDeps;
  claim: Claim;
  deadline: number;
  syncToken: string | null;
};

class StopSync extends Error {
  constructor(
    readonly outcome: SyncOutcome,
    readonly code: string,
  ) {
    super(code);
  }
}

const superseded = () => new StopSync("superseded", "stale_claim");

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

function checkDeadline(pass: SyncPass) {
  if (Date.now() >= pass.deadline) {
    throw new StopSync("stale", "budget_exceeded");
  }
}

/** A provider call with the claim's credentials, within the deadline. */
export function providerCall<T>(
  pass: SyncPass,
  run: (accessToken: string, deadline: number) => Promise<T>,
): Promise<T> {
  checkDeadline(pass);
  return withAccessToken(
    pass.deps,
    pass.claim.connectionId,
    (token) => run(token, pass.deadline),
    { generation: pass.claim.connectionGeneration, deadline: pass.deadline },
  );
}

function listEvents(
  pass: SyncPass,
  query: EventQuery,
  pageToken: string | null,
): Promise<ProviderEventPage> {
  const provider = pass.deps.provider(pass.claim.provider);
  return providerCall(pass, (token, deadline) =>
    provider.listEvents(
      token,
      pass.claim.providerCalendarId,
      query,
      pageToken,
      { deadline },
    ),
  );
}

/**
 * Applies one page for the claim. "timezone_changed": nothing applied, the
 * zone was updated and the sync invalidated (a new full sync re-projects
 * all-day events).
 */
async function applyPage(
  pass: SyncPass,
  generation: number | null,
  page: ProviderEventPage,
): Promise<"applied" | "timezone_changed"> {
  const result = (await rpc(
    pass.deps.admin.rpc("calendar_apply_events", {
      p_calendar_id: pass.claim.calendarId,
      p_claim_id: pass.claim.claimId,
      // null: incremental page (rows keep the committed generation).
      p_generation: generation as number,
      p_provider_timezone: page.timezone as string,
      p_events: page.events.map(toApplied),
      p_next_page_token: page.nextPageToken as string,
    }),
  )) as { applied: boolean; reason?: string };
  if (result.applied) return "applied";
  if (result.reason === "timezone_changed") {
    logCalendar("calendar_timezone_changed", {
      calendarId: pass.claim.calendarId,
      timezone: page.timezone?.slice(0, 64),
    });
    return "timezone_changed";
  }
  // stale_claim / stale_generation: another worker owns the calendar now.
  throw superseded();
}

async function resetSync(pass: SyncPass) {
  const reset = await rpc(
    pass.deps.admin.rpc("calendar_reset_sync", {
      p_calendar_id: pass.claim.calendarId,
      p_claim_id: pass.claim.claimId,
    }),
  );
  if (!reset) throw superseded();
  pass.syncToken = null;
}

async function fullSync(pass: SyncPass, restarts = 0): Promise<void> {
  const start = (await rpc(
    pass.deps.admin.rpc("calendar_start_full_sync", {
      p_calendar_id: pass.claim.calendarId,
      p_claim_id: pass.claim.claimId,
    }),
  )) as {
    generation: number;
    pageToken: string | null;
    windowStart: string;
    windowEnd: string;
  } | null;
  if (!start) throw superseded();

  const query: EventQuery = {
    kind: "full",
    timeMin: new Date(start.windowStart).toISOString(),
    timeMax: new Date(start.windowEnd).toISOString(),
  };
  let pageToken = start.pageToken;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result;
    try {
      result = await listEvents(pass, query, pageToken);
    } catch (error) {
      // A resumed page cursor the provider no longer accepts: start over
      // from page 1, with a new generation.
      if (
        pageToken &&
        restarts < MAX_RESTARTS &&
        error instanceof CalendarProviderError &&
        (error.kind === "gone" || error.kind === "bad_request")
      ) {
        await resetSync(pass);
        return fullSync(pass, restarts + 1);
      }
      throw error;
    }

    if ((await applyPage(pass, start.generation, result)) !== "applied") {
      if (restarts >= MAX_RESTARTS) {
        throw new StopSync("stale", "timezone_changed");
      }
      return fullSync(pass, restarts + 1);
    }

    if (!result.nextPageToken) {
      // The adapter guarantees the last page carries the cursor.
      const finished = await rpc(
        pass.deps.admin.rpc("calendar_finish_full_sync", {
          p_calendar_id: pass.claim.calendarId,
          p_claim_id: pass.claim.claimId,
          p_generation: start.generation,
          p_sync_token: result.nextSyncToken!,
        }),
      );
      if (!finished) throw superseded();
      pass.syncToken = result.nextSyncToken;
      return;
    }
    pageToken = result.nextPageToken;
  }

  throw new StopSync("incomplete", "too_many_events");
}

/**
 * Applies the changes since the committed cursor. Anything but "done" means
 * a full sync is needed.
 */
async function incrementalSync(
  pass: SyncPass,
): Promise<"done" | "gone" | "too_long" | "timezone_changed"> {
  const syncToken = pass.syncToken!;
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result;
    try {
      result = await listEvents(
        pass,
        { kind: "incremental", syncToken },
        pageToken,
      );
    } catch (error) {
      if (error instanceof CalendarProviderError && error.kind === "gone") {
        return "gone";
      }
      throw error;
    }

    if ((await applyPage(pass, null, result)) !== "applied") {
      return "timezone_changed";
    }

    if (!result.nextPageToken) {
      const finished = await rpc(
        pass.deps.admin.rpc("calendar_finish_incremental_sync", {
          p_calendar_id: pass.claim.calendarId,
          p_claim_id: pass.claim.claimId,
          p_sync_token: result.nextSyncToken!,
        }),
      );
      if (!finished) throw superseded();
      pass.syncToken = result.nextSyncToken;
      return "done";
    }
    pageToken = result.nextPageToken;
  }
  // Too many changes to replay within a pass: the page cursor of an
  // incremental sync is not kept, a full sync (new generation) replaces it.
  return "too_long";
}

function needsFullSync(claim: Claim) {
  if (!claim.syncToken || claim.fullInProgress || !claim.windowEnd) return true;
  // The window slides: refresh it before it no longer covers 380 days.
  return new Date(claim.windowEnd).getTime() < Date.now() + 380 * 86_400_000;
}

/** Incremental when possible, otherwise (or when it cannot finish) full. */
async function bringUpToDate(pass: SyncPass) {
  if (!pass.syncToken) return fullSync(pass);
  const result = await incrementalSync(pass);
  if (result === "done") return;
  logCalendar(
    "sync_full_required",
    { calendarId: pass.claim.calendarId, code: result },
    "warn",
  );
  await resetSync(pass);
  await fullSync(pass);
}

async function syncOnce(pass: SyncPass): Promise<void> {
  if (needsFullSync(pass.claim)) {
    pass.syncToken = null;
    await fullSync(pass);
  } else {
    await bringUpToDate(pass);
  }

  // Channel renewal without a gap: the new channel is created and recorded
  // first (notifications are accepted from then on), then a catch-up sync
  // covers whatever changed while no recorded channel could report it, and
  // only then is the previous channel stopped.
  const channel = await ensureChannel(pass);
  if (channel.status === "superseded") throw superseded();
  if (channel.status === "recorded") {
    try {
      await bringUpToDate(pass);
    } finally {
      if (channel.replaced) {
        await stopChannels(
          pass.deps,
          pass.claim.connectionId,
          pass.claim.provider,
          [channel.replaced],
          {
            generation: pass.claim.connectionGeneration,
            deadline: pass.deadline + 5_000,
          },
        );
      }
    }
  }
}

function failureOf(
  error: unknown,
  deadline: number,
): { outcome: SyncOutcome; code: string } {
  if (error instanceof StopSync) {
    return { outcome: error.outcome, code: error.code };
  }
  if (error instanceof StaleCredentialsError) {
    return { outcome: "superseded", code: "stale_credentials" };
  }
  if (error instanceof CalendarProviderError) {
    // Cut by the pass deadline: resumed by the next pass.
    if (Date.now() >= deadline) {
      return { outcome: "stale", code: "budget_exceeded" };
    }
    return { outcome: "error", code: `provider_${error.kind}` };
  }
  if (error instanceof AppException) {
    // invalid_input from the database: an event it cannot place.
    return {
      outcome: "error",
      code:
        error.code === "validation_error" ? "provider_protocol" : error.code,
    };
  }
  return { outcome: "error", code: "internal" };
}

/** What the database records for an outcome. */
const releaseOutcome: Record<SyncOutcome, string> = {
  synced: "synced",
  error: "error",
  incomplete: "incomplete",
  stale: "stale",
  superseded: "skipped",
  skipped: "skipped",
  busy: "skipped",
};

/**
 * Synchronises one calendar. Never throws: the outcome is returned and
 * recorded on the calendar (sync_status / last_error) by the claimant only.
 */
export async function syncCalendar(
  deps: CalendarDeps,
  calendarId: string,
  options: { budgetMs?: number } = {},
): Promise<SyncOutcome> {
  const deadline = Date.now() + (options.budgetMs ?? 25_000);
  let outcome: SyncOutcome = "skipped";

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return round === 0 ? "stale" : outcome;

    const { data, error } = await deps.admin.rpc("calendar_claim_sync", {
      p_calendar_id: calendarId,
      // The pass ends at its deadline; the lease outlives it by 30 s.
      p_lease_seconds: Math.ceil(remaining / 1000) + 30,
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
    if (!claim.claimed) return round === 0 ? "busy" : outcome;

    const pass: SyncPass = {
      deps,
      claim,
      deadline,
      syncToken: claim.syncToken,
    };
    let failure: string | null = null;
    outcome = "synced";
    try {
      await syncOnce(pass);
      logCalendar("sync_done", {
        calendarId,
        connectionId: claim.connectionId,
        businessId: claim.businessId,
        provider: claim.provider,
      });
    } catch (caught) {
      const result = failureOf(caught, deadline);
      outcome = result.outcome;
      failure = result.code;
      logCalendar(
        "sync_failed",
        {
          calendarId,
          connectionId: claim.connectionId,
          businessId: claim.businessId,
          provider: claim.provider,
          code: failure,
        },
        outcome === "superseded" ? "info" : "warn",
      );
    }

    const again = await rpc(
      deps.admin.rpc("calendar_release_sync", {
        p_calendar_id: calendarId,
        p_claim_id: claim.claimId,
        p_outcome: releaseOutcome[outcome],
        p_error: (outcome === "superseded" ? null : failure) as string,
      }),
    ).catch(() => false);

    if (!again || outcome !== "synced") return outcome;
  }
  return outcome;
}
