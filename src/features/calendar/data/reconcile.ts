import "server-only";

import {
  CalendarProviderError,
  type CalendarProviderId,
  type OwnedEventPage,
} from "@/features/calendar/providers/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";

import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { outboundEvent } from "./outbound-event";
import { StaleCredentialsError, withAccessToken } from "./tokens";

// Backfill and reconciliation of outbound, from the periodic job only (never
// a request, an appointment or an enabling transaction).
//
// Backfill enrolls appointments that must be in Google and have not ended
// but were never enrolled (SQL only, bounded batches): the normal writer
// applies them.
//
// Reconciliation lists the current dedicated calendar (a full scan, then
// incremental changes with Google's sync token), compares the events whose
// id is one of this business's mirrors' deterministic ids with what the
// writer would send now (the same serializer, the Booking-owned fields
// only), and records each drift as a repair request of the mirror: the
// normal writer repairs it. Events of no mirror (created by the
// professional) are ignored; nothing is ever deleted that Booking did not
// write, nothing ever goes from Google into Booking, nor into inbound.
//
// Authority: each pass holds a claim (outbound generation, calendar,
// credential generation); SQL re-checks it before recording anything a
// listing implies. Sync tokens stay server-side, never logged.

const PROVIDER: CalendarProviderId = "google";

/** Businesses reconciled at most per run. */
export const RECONCILIATION_BUSINESSES_PER_RUN = 5;
/** Pages (250 events each) listed at most per business and run; a longer
 * listing resumes at the next run from its stored page token. */
export const RECONCILIATION_PAGES_PER_PASS = 4;
/** Businesses and appointments enrolled at most per backfill run. */
export const BACKFILL_BUSINESSES_PER_RUN = 5;
export const BACKFILL_APPOINTMENTS_PER_BUSINESS = 100;
// A calendar is listed again 30 minutes after its last complete listing
// (private.reconciliation_interval(), the authority); the periodic job runs
// every 15 minutes.

const DETERMINISTIC_EVENT_ID = /^bk[0-9a-f]{32}$/;

type ReconciliationClaim = {
  businessId: string;
  claimId: string;
  connectionId: string;
  credentialGeneration: string;
  calendarId: string;
  mode: "full" | "incremental";
  syncToken: string | null;
  pageToken: string | null;
};

type SnapshotItem = {
  appointmentId: string;
  eventId: string;
  revision: number;
  pending: boolean;
  active: boolean;
  eligible: boolean;
  startsAt: string | null;
  endsAt: string | null;
  serviceName: string | null;
  clientFirstName: string | null;
};

type FailureOutcome =
  | "retry"
  | "rate_limited"
  | "invalid_token"
  | "calendar_deleted"
  | "write_authorization_required";

export type ReconcileOutcome =
  "done" | "paused" | "retry" | "reset" | "action_required" | "superseded";

export type ReconcileRunResult = {
  reconciled: number;
  drifted: number;
  actionRequired: number;
};

/** A database call aborted with `signal`; never started once aborted. */
function abortable<T extends { abortSignal(signal: AbortSignal): T }>(
  query: T,
  signal: AbortSignal | undefined,
) {
  return signal ? query.abortSignal(signal) : query;
}

/** Enrolls a bounded batch of never-enrolled, not ended appointments. */
export async function backfillOutbound(
  deps: CalendarDeps,
  signal?: AbortSignal,
) {
  const { data, error } = await abortable(
    deps.admin.rpc("calendar_outbound_backfill", {
      p_businesses: BACKFILL_BUSINESSES_PER_RUN,
      p_per_business: BACKFILL_APPOINTMENTS_PER_BUSINESS,
    }),
    signal,
  );
  if (error) throw databaseException(error);
  const result = data as { businesses: number; enrolled: number };
  if (result.enrolled > 0) {
    logCalendar("outbound_backfilled", { count: result.enrolled });
  }
  return result.enrolled;
}

const stale = (error: unknown) =>
  error instanceof StaleCredentialsError ||
  (error instanceof AppException &&
    (error.code === "calendar_reauth_required" ||
      error.code === "calendar_not_connected"));

/**
 * One business: pages of its dedicated calendar, from the stored cursor, at
 * most `maxPages`, within `deadline`. A listing that cannot finish keeps its
 * cursor (resumed at the next run); missing events are decided only by the
 * last page of a complete full scan (in SQL).
 */
async function reconcileCalendar(
  deps: CalendarDeps,
  claim: ReconciliationClaim,
  options: { deadline: number; maxPages: number; signal?: AbortSignal },
): Promise<{ outcome: ReconcileOutcome; drifted: number }> {
  const provider = deps.provider(PROVIDER);
  const authority = {
    p_business_id: claim.businessId,
    p_claim_id: claim.claimId,
  };
  let drifted = 0;

  const fail = async (outcome: FailureOutcome, code: string) => {
    const { data, error } = await deps.admin.rpc(
      "calendar_outbound_reconciliation_failed",
      { ...authority, p_outcome: outcome, p_error: code },
    );
    if (error) throw databaseException(error);
    if (data === "superseded")
      return { outcome: "superseded" as const, drifted };
    logCalendar(
      "outbound_reconcile_failed",
      { businessId: claim.businessId, code, status: outcome },
      data === "action_required" ? "warn" : "info",
    );
    return {
      outcome: (data === "action_required"
        ? "action_required"
        : data === "reset"
          ? "reset"
          : "retry") as ReconcileOutcome,
      drifted,
    };
  };

  let pageToken = claim.pageToken;
  for (let page = 0; ; page += 1) {
    if (
      page >= options.maxPages ||
      options.signal?.aborted === true ||
      options.deadline - Date.now() < 3000
    ) {
      // Stopped by this run's limits: resumed at the next one.
      await deps.admin.rpc(
        "calendar_outbound_reconciliation_release",
        authority,
      );
      return { outcome: "paused", drifted };
    }

    const query =
      claim.mode === "incremental"
        ? { kind: "incremental" as const, syncToken: claim.syncToken! }
        : { kind: "full" as const };
    let listed: OwnedEventPage | { calendarGone: true };
    try {
      listed = await withAccessToken(
        deps,
        claim.connectionId,
        async (token) => {
          try {
            return await provider.listOwnedEvents(
              token,
              claim.calendarId,
              query,
              pageToken,
              { deadline: options.deadline },
            );
          } catch (error) {
            if (
              error instanceof CalendarProviderError &&
              error.kind === "not_found" &&
              !(await provider.calendarExists(token, claim.calendarId, {
                deadline: options.deadline,
              }))
            ) {
              return { calendarGone: true as const };
            }
            throw error;
          }
        },
        { generation: claim.credentialGeneration, deadline: options.deadline },
      );
    } catch (error) {
      if (stale(error)) return { outcome: "superseded", drifted };
      if (!(error instanceof CalendarProviderError)) {
        return fail("retry", "internal");
      }
      switch (error.kind) {
        case "gone":
          return fail("invalid_token", error.kind);
        case "forbidden":
          return fail("write_authorization_required", error.kind);
        case "rate_limited":
          return fail("rate_limited", error.kind);
        case "bad_request":
          // A cursor Google no longer accepts: a new full scan.
          return fail(
            claim.syncToken || pageToken ? "invalid_token" : "retry",
            error.kind,
          );
        default:
          return fail("retry", error.kind);
      }
    }
    if ("calendarGone" in listed) return fail("calendar_deleted", "not_found");

    const events = new Map(
      listed.events
        .filter((event) => DETERMINISTIC_EVENT_ID.test(event.id))
        .map((event) => [event.id, event]),
    );
    let snapshot: SnapshotItem[] = [];
    if (events.size > 0) {
      const { data, error } = await deps.admin.rpc(
        "calendar_outbound_reconciliation_snapshot",
        { ...authority, p_event_ids: [...events.keys()] },
      );
      if (error) throw databaseException(error);
      snapshot = (data ?? []) as SnapshotItem[];
    }

    // Compared only for mirrors at rest (a pending revision is rewritten in
    // full anyway) whose appointment has not ended.
    const differing = snapshot
      .filter((item) => !item.pending && item.eligible)
      .filter((item) =>
        provider.ownedEventDiffers(
          item.active ? outboundEvent(item) : null,
          events.get(item.eventId)!,
        ),
      )
      .map((item) => ({
        appointment_id: item.appointmentId,
        revision: item.revision,
      }));

    const { data: recorded, error: recordError } = await deps.admin.rpc(
      "calendar_outbound_reconciliation_page",
      {
        ...authority,
        p_drifted: differing,
        p_seen_event_ids: claim.mode === "full" ? [...events.keys()] : [],
        p_next_page_token: listed.nextPageToken as string,
        p_next_sync_token: listed.nextSyncToken as string,
      },
    );
    if (recordError) throw databaseException(recordError);
    const pageResult = recorded as {
      result: "continue" | "done" | "superseded";
      repairs: number;
    };
    if (pageResult.result === "superseded")
      return { outcome: "superseded", drifted };
    // Repairs actually recorded (a comparison made stale by a newer
    // revision or write is not one), missing events of a full scan included.
    drifted += pageResult.repairs;
    if (pageResult.result === "done") return { outcome: "done", drifted };
    pageToken = listed.nextPageToken;
  }
}

/**
 * Reconciles the due businesses (fairly: the longest waiting first, each
 * at most once per run), within `deadline`. Nothing new starts once
 * `signal` is aborted.
 */
export async function reconcileOutbound(
  deps: CalendarDeps,
  options: {
    deadline: number;
    signal?: AbortSignal;
    maxBusinesses?: number;
    maxPages?: number;
  },
): Promise<ReconcileRunResult> {
  const result: ReconcileRunResult = {
    reconciled: 0,
    drifted: 0,
    actionRequired: 0,
  };
  const handled: string[] = [];
  const maxBusinesses =
    options.maxBusinesses ?? RECONCILIATION_BUSINESSES_PER_RUN;

  while (handled.length < maxBusinesses) {
    if (options.signal?.aborted === true) break;
    if (options.deadline - Date.now() < 5000) break;
    const { data, error } = await abortable(
      deps.admin.rpc("calendar_outbound_claim_reconciliation", {
        p_exclude: handled,
      }),
      options.signal,
    );
    if (error) throw databaseException(error);
    if (!data) break;
    const claim = data as ReconciliationClaim;
    handled.push(claim.businessId);

    const { outcome, drifted } = await reconcileCalendar(deps, claim, {
      deadline: options.deadline,
      maxPages: options.maxPages ?? RECONCILIATION_PAGES_PER_PASS,
      signal: options.signal,
    });
    result.drifted += drifted;
    if (outcome === "done") result.reconciled += 1;
    if (outcome === "action_required") result.actionRequired += 1;
    if (drifted > 0) {
      logCalendar(
        "outbound_drift_detected",
        { businessId: claim.businessId, count: drifted },
        "warn",
      );
    }
  }
  return result;
}
