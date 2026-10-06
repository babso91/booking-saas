import "server-only";

import { bookingCalendarDescription } from "@/features/calendar/providers/google";
import {
  CalendarProviderError,
  type CalendarProviderId,
  type OutboundEvent,
} from "@/features/calendar/providers/types";
import { withinDeadline } from "@/features/calendar/providers/http";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";

import {
  beginOAuthState,
  type CalendarContext,
  type ConsumedOAuthState,
} from "./connection";
import { tokenAad, type CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { outboundEvent } from "./outbound-event";
import {
  backfillOutbound,
  RECONCILIATION_MIN_START_MS,
  reconcileOutbound,
} from "./reconcile";
import {
  getAccessToken,
  StaleCredentialsError,
  withAccessToken,
} from "./tokens";

// Outbound: Booking appointments mirrored to a dedicated Google calendar the
// app creates (scope calendar.app.created). Booking stays the source of
// truth; Google is a convenience copy, never read back into appointments.
//
// Appointment transactions only record a desired state (SQL trigger, every
// write path); this module applies it after commit: in the background after
// the action or booking that changed it (best effort), and from the
// periodic job (durable catch-up). Nothing here runs inside a Booking
// transaction or under the schedule lock, and a provider failure never
// reaches the appointment.
//
// Authority: every worker captures the outbound generation, the credential
// generation and the desired revision with its claim; SQL re-checks them
// before recording anything a provider answer implies. Stale workers write
// nothing locally. Event ids are deterministic, so a provider write that
// lands late or twice never creates a duplicate.

const PROVIDER: CalendarProviderId = "google";

export { outboundEvent };

export type CalendarOutboundState =
  "disabled" | "creating" | "active" | "action_required";

export type CalendarOutboundStatusDto = {
  provider: CalendarProviderId;
  /** False when the server has no calendar configuration. */
  available: boolean;
  /** A Google connection exists (active or waiting for a reconnection). */
  googleConnected: boolean;
  /** The connected account granted the write scope (calendar.app.created). */
  writeAuthorized: boolean;
  /** Enabled by the professional (not disabled, nor stopped by a disconnection). */
  enabled: boolean;
  state: CalendarOutboundState;
  /**
   * disabled: outbound is off; healthy: every change is in Google;
   * pending: changes (or the dedicated calendar) are on their way;
   * retrying: the provider failed for some changes, retried automatically;
   * action_required: nothing reaches Google until the professional acts
   * (`actionRequired`). Changes made meanwhile are kept and sent later.
   */
  health: "disabled" | "healthy" | "pending" | "retrying" | "action_required";
  /** The dedicated calendar exists and is the target. */
  calendarCreated: boolean;
  /**
   * What the professional must do: authorize_write (grant the write scope),
   * reconnect (the Google connection expired), reactivate (the dedicated
   * calendar was deleted, or its creation could not be confirmed: start a
   * new attempt explicitly, which looks for it first), enable_again (the
   * connection now uses another Google account).
   */
  actionRequired:
    "authorize_write" | "reconnect" | "reactivate" | "enable_again" | null;
  reason:
    | "calendar_deleted"
    | "calendar_creation_uncertain"
    | "write_authorization_required"
    | "account_changed"
    | "reauth_required"
    | null;
  /** Appointments whose latest change is not in Google yet. */
  pendingCount: number;
  /** Among them, those whose last attempt failed (retried with backoff). */
  errorCount: number;
  lastError: string | null;
};

type RawStatus = {
  connectionStatus: "active" | "reauth_required" | "disconnected" | null;
  writeAuthorized: boolean;
  status: CalendarOutboundState;
  actionCode:
    | "calendar_deleted"
    | "calendar_creation_uncertain"
    | "write_authorization_required"
    | "account_changed"
    | null;
  calendarCreated: boolean;
  lastError: string | null;
  pendingCount: number;
  errorCount: number;
};

export function toOutboundStatusDto(
  raw: RawStatus,
  available: boolean,
): CalendarOutboundStatusDto {
  const connected =
    raw.connectionStatus === "active" ||
    raw.connectionStatus === "reauth_required";
  const enabled = raw.status !== "disabled";
  let health: CalendarOutboundStatusDto["health"];
  let actionRequired: CalendarOutboundStatusDto["actionRequired"] = null;
  let reason: CalendarOutboundStatusDto["reason"] = null;

  if (!enabled) {
    health = "disabled";
    if (raw.actionCode === "account_changed") {
      actionRequired = "enable_again";
      reason = "account_changed";
    }
  } else if (raw.connectionStatus !== "active") {
    health = "action_required";
    actionRequired = "reconnect";
    reason = "reauth_required";
  } else if (
    !raw.writeAuthorized ||
    raw.actionCode === "write_authorization_required"
  ) {
    health = "action_required";
    actionRequired = "authorize_write";
    reason = "write_authorization_required";
  } else if (raw.status === "action_required") {
    health = "action_required";
    actionRequired = "reactivate";
    reason =
      raw.actionCode === "calendar_creation_uncertain"
        ? "calendar_creation_uncertain"
        : "calendar_deleted";
  } else if (raw.status === "creating") {
    health = "pending";
  } else if (raw.errorCount > 0) {
    health = "retrying";
  } else if (raw.pendingCount > 0) {
    health = "pending";
  } else {
    health = "healthy";
  }

  return {
    provider: PROVIDER,
    available,
    googleConnected: connected,
    writeAuthorized: raw.writeAuthorized,
    enabled,
    state: raw.status,
    health,
    calendarCreated: raw.calendarCreated,
    actionRequired,
    reason,
    pendingCount: Number(raw.pendingCount),
    errorCount: Number(raw.errorCount),
    lastError: raw.lastError,
  };
}

export async function getOutboundStatus(
  context: CalendarContext,
  available: boolean,
): Promise<CalendarOutboundStatusDto> {
  const { data, error } = await context.client.rpc("calendar_outbound_status", {
    p_business_id: context.businessId,
  });
  if (error) throw databaseException(error);
  return toOutboundStatusDto(data as RawStatus, available);
}

/**
 * Starts the incremental authorization of the write scope for the Google
 * account already connected (login hint). Returns the provider URL.
 */
export async function startWriteAuthorization(
  context: CalendarContext,
  deps: CalendarDeps,
) {
  const { data: connection, error } = await deps.admin
    .from("calendar_connections")
    .select("provider_account_id, status")
    .eq("business_id", context.businessId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw databaseException(error);
  if (!connection || connection.status === "disconnected") {
    throw new AppException("calendar_not_connected");
  }
  if (connection.status !== "active") {
    throw new AppException("calendar_reauth_required");
  }

  const { state, codeChallenge } = await beginOAuthState(
    context,
    deps,
    "write",
  );
  return {
    authorizationUrl: deps.provider(PROVIDER).writeAuthorizationUrl({
      state,
      codeChallenge,
      redirectUri: deps.env.GOOGLE_CALENDAR_REDIRECT_URI,
      loginHint: connection.provider_account_id,
    }),
  };
}

/**
 * Completes the write authorization (consumed `write` state). The answering
 * Google account must be exactly the connected one: another account is
 * refused before anything is stored (its tokens are dropped, the connection
 * and its calendars stay as they were). Then outbound is enabled: the
 * professional asked for it.
 */
export async function completeWriteAuthorization(
  context: CalendarContext,
  deps: CalendarDeps,
  consumed: ConsumedOAuthState,
  code: string,
) {
  const provider = deps.provider(consumed.provider);

  const { data: connection, error: connectionError } = await deps.admin
    .from("calendar_connections")
    .select("id, provider_account_id, status")
    .eq("business_id", context.businessId)
    .eq("provider", provider.id)
    .maybeSingle();
  if (connectionError) throw databaseException(connectionError);
  if (!connection || connection.status !== "active") {
    throw new AppException("calendar_not_connected");
  }

  let tokens;
  try {
    tokens = await provider.exchangeCode({
      code,
      codeVerifier: consumed.codeVerifier,
      redirectUri: deps.env.GOOGLE_CALENDAR_REDIRECT_URI,
    });
  } catch (error) {
    throw error instanceof CalendarProviderError
      ? new AppException("calendar_provider_unavailable", { cause: error })
      : error;
  }
  if (tokens.account.id !== connection.provider_account_id) {
    logCalendar(
      "write_authorization_account_mismatch",
      { businessId: context.businessId, connectionId: connection.id },
      "warn",
    );
    throw new AppException("calendar_account_mismatch");
  }
  if (!tokens.scopes.includes(provider.writeScope)) {
    throw new AppException("calendar_scope_missing");
  }

  const aad = tokenAad(context.businessId, provider.id);
  const { data: stored, error } = await deps.admin.rpc(
    "calendar_add_write_authorization",
    {
      p_business_id: context.businessId,
      p_user_id: context.userId,
      p_provider_account_id: tokens.account.id,
      p_scopes: tokens.scopes,
      // null: no new refresh token, the stored one is kept.
      p_refresh_token_ciphertext: (tokens.refreshToken
        ? encryptSecret(tokens.refreshToken, aad, deps.keys[0]!)
        : null) as string,
      p_access_token_ciphertext: encryptSecret(
        tokens.accessToken,
        aad,
        deps.keys[0]!,
      ),
      p_access_token_expires_at: tokens.expiresAt.toISOString(),
    },
  );
  if (error) throw databaseException(error);
  if (stored === "account_mismatch") {
    throw new AppException("calendar_account_mismatch");
  }
  if (stored !== "stored") throw new AppException("calendar_not_connected");

  logCalendar("write_authorized", {
    businessId: context.businessId,
    connectionId: connection.id,
  });
  await enableOutbound(context);
  return { connectionId: connection.id };
}

/** Enables outbound (or reactivates it after an action required). */
export async function enableOutbound(context: CalendarContext) {
  const { data, error } = await context.client.rpc("calendar_outbound_enable", {
    p_business_id: context.businessId,
  });
  if (error) throw databaseException(error);
  logCalendar("outbound_enabled", { businessId: context.businessId });
  return data as RawStatus;
}

export async function disableOutbound(context: CalendarContext) {
  const { data, error } = await context.client.rpc(
    "calendar_outbound_disable",
    { p_business_id: context.businessId },
  );
  if (error) throw databaseException(error);
  logCalendar("outbound_disabled", { businessId: context.businessId });
  return data as RawStatus;
}

export async function retryOutbound(context: CalendarContext) {
  const { data, error } = await context.client.rpc("calendar_outbound_retry", {
    p_business_id: context.businessId,
  });
  if (error) throw databaseException(error);
  return data as RawStatus;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

type CreationClaim = {
  claimId: string;
  generation: string;
  connectionId: string;
  credentialGeneration: string;
  marker: string;
  nonce: string;
  businessName: string;
  timezone: string;
  /** An insert of this attempt was sent, its outcome unknown. */
  requested: boolean;
  /** Calendars of this account adopted before (proven), most recent first. */
  knownCalendarIds: string[];
};

export type CreationOutcome =
  "created" | "recovered" | "busy" | "superseded" | "retry" | "action_required";

type CreationFailure =
  "definite" | "ambiguous" | "not_found" | "multiple" | "forbidden" | "retry";

/**
 * Candidates (marker found, not adopted before) proven at most in one
 * creation step. Beyond, the set cannot be decided within the step: nothing
 * is chosen (calendar_creation_uncertain).
 */
const MAX_CANDIDATES = 5;

/**
 * Among `calendarIds`, those attributed to another business (or to this one
 * under another Google account): never proven, never written to, never
 * adopted. Advisory: the attribution itself is decided atomically in SQL by
 * calendar_outbound_adopt_calendar.
 */
async function attributedElsewhere(
  deps: CalendarDeps,
  businessId: string,
  calendarIds: string[],
) {
  if (calendarIds.length === 0) return new Set<string>();
  const { data, error } = await deps.admin.rpc(
    "calendar_outbound_attributed_elsewhere",
    { p_business_id: businessId, p_provider_calendar_ids: calendarIds },
  );
  if (error) throw databaseException(error);
  return new Set((data ?? []).map((row) => row.provider_calendar_id));
}

/**
 * Proves that Booking may write to a candidate calendar, through the only
 * capability calendar.app.created gives on the calendars the app created
 * (and on no other): writing an event. A sentinel event, with an id of its
 * own and no personal data, is written then removed at once. A personal
 * calendar carrying a copied marker answers 403 (or 404): never adopted.
 * The description (the marker) only lists the candidates.
 */
async function provesOwnership(
  deps: CalendarDeps,
  token: string,
  calendarId: string,
  nonce: string,
  deadline: number,
) {
  const provider = deps.provider(PROVIDER);
  const sentinel: OutboundEvent = {
    id: `bkprobe${nonce.replace(/-/g, "")}`,
    summary: "Booking",
    startsAt: "2000-01-01T00:00:00Z",
    endsAt: "2000-01-01T00:01:00Z",
    privateProperties: { origin: "booking-saas", probe: "1" },
  };
  try {
    try {
      await provider.insertEvent(token, calendarId, sentinel, { deadline });
    } catch (error) {
      if (!isKind(error, "conflict")) throw error;
      await provider.restoreEvent(token, calendarId, sentinel, { deadline });
    }
  } catch (error) {
    if (isKind(error, "forbidden", "not_found")) return false;
    throw error;
  }
  await provider
    .deleteEvent(token, calendarId, sentinel.id, { deadline })
    .catch(() => undefined);
  return true;
}

/**
 * Creates the dedicated calendar, or finds it again, without ever creating
 * two automatically. Google offers no idempotency key for calendars.insert,
 * so:
 *
 * - every step starts by searching the calendar list, and decides only once
 *   the whole set of possible targets is known: the calendars this business
 *   adopted before for this account (its history, a local proof) and the
 *   candidates carrying its marker (any attempt's nonce). A candidate
 *   attributed to another business is dropped before anything is sent to
 *   it; every other one must pass the ownership proof (sentinel write); the
 *   marker alone proves nothing. Exactly one valid target: adopted, and
 *   only if SQL attributes it to this business. Several: never chosen
 *   between (calendar_creation_uncertain);
 * - the insert is recorded (committed) before it is sent, at most once per
 *   attempt, and never retried by the HTTP client;
 * - a certain failure (refused: 4xx, 429) lets the attempt insert again
 *   later; an ambiguous one (timeout, network, 5xx, unreadable answer) only
 *   allows bounded searches, then calendar_creation_uncertain. A new insert
 *   needs a new, explicit attempt of the professional (which searches
 *   first, too).
 *
 * One worker at a time per business (claim); every recorded outcome
 * re-checks the claim's authority (claim, generation, credentials).
 */
export async function ensureOutboundCalendar(
  deps: CalendarDeps,
  businessId: string,
  options: { deadline?: number } = {},
): Promise<CreationOutcome> {
  const { data, error } = await deps.admin.rpc(
    "calendar_outbound_begin_creation",
    { p_business_id: businessId },
  );
  if (error) throw databaseException(error);
  if (!data) return "busy";
  const claim = data as CreationClaim;
  const provider = deps.provider(PROVIDER);
  const deadline = options.deadline ?? Date.now() + 20_000;
  const authority = {
    p_business_id: businessId,
    p_claim_id: claim.claimId,
    p_generation: claim.generation,
    p_credential_generation: claim.credentialGeneration,
  };

  const fail = async (outcome: CreationFailure, code: string) => {
    const { data: recorded, error: failError } = await deps.admin.rpc(
      "calendar_outbound_creation_failed",
      { ...authority, p_outcome: outcome, p_error: code },
    );
    if (failError) throw databaseException(failError);
    if (recorded === "superseded") return "superseded" as const;
    logCalendar(
      "outbound_calendar_failed",
      { businessId, code, status: outcome },
      recorded === "retry" ? "warn" : "error",
    );
    return recorded === "retry"
      ? ("retry" as const)
      : ("action_required" as const);
  };

  const adopt = async (calendarId: string, created: boolean) => {
    const { data: adopted, error: adoptError } = await deps.admin.rpc(
      "calendar_outbound_adopt_calendar",
      { ...authority, p_provider_calendar_id: calendarId },
    );
    if (adoptError) throw databaseException(adoptError);
    if (adopted === "attributed_elsewhere") {
      // Another business owns it (attributed meanwhile, a concurrent
      // adoption included): never this one's. The next step searches
      // again, without it.
      return fail("retry", "calendar_attributed_elsewhere");
    }
    if (adopted !== "adopted") {
      logCalendar("outbound_calendar_superseded", { businessId }, "warn");
      return "superseded" as const;
    }
    logCalendar(
      created ? "outbound_calendar_created" : "outbound_calendar_recovered",
      { businessId },
    );
    return created ? ("created" as const) : ("recovered" as const);
  };

  const stale = (error: unknown) =>
    error instanceof StaleCredentialsError ||
    (error instanceof AppException &&
      (error.code === "calendar_reauth_required" ||
        error.code === "calendar_not_connected"));

  // 1. Search (read-only but for the sentinels, safe to run again after a
  // token refresh): the complete set of valid targets first, the decision
  // after, never the other way round.
  let search;
  try {
    search = await withAccessToken(
      deps,
      claim.connectionId,
      async (token) => {
        const calendars = await provider.listCalendars(token, { deadline });
        const visible = new Set(calendars.map((calendar) => calendar.id));
        // Adopted before by this business for this account: valid as is.
        const known = claim.knownCalendarIds.filter((id) => visible.has(id));
        // Carrying the marker, whatever the attempt: candidates only. One
        // attributed to another business gets nothing, not even a sentinel.
        const marked = calendars
          .filter(
            (calendar) =>
              calendar.bookingMarker === claim.marker &&
              !claim.knownCalendarIds.includes(calendar.id),
          )
          .map((calendar) => calendar.id)
          .sort();
        const elsewhere = await attributedElsewhere(deps, businessId, marked);
        const candidates = marked.filter((id) => !elsewhere.has(id));
        // Already ambiguous, or too many to decide in one step: no proof.
        if (known.length > 1 || candidates.length > MAX_CANDIDATES) {
          return { valid: known, undecided: true };
        }
        const valid = [...known];
        for (const id of candidates) {
          if (await provesOwnership(deps, token, id, claim.nonce, deadline)) {
            valid.push(id);
          }
        }
        return { valid, undecided: false };
      },
      { generation: claim.credentialGeneration, deadline },
    );
  } catch (error) {
    if (stale(error)) return "superseded";
    return fail(
      "retry",
      error instanceof CalendarProviderError ? error.kind : "internal",
    );
  }

  // Exactly one valid target, or none: never a choice between several.
  if (search.undecided || search.valid.length > 1) {
    return fail("multiple", "multiple_candidates");
  }
  if (search.valid.length === 1) return adopt(search.valid[0]!, false);
  // An insert of this attempt may have created a calendar not listed yet:
  // never a second insert, only searches.
  if (claim.requested) return fail("not_found", "creation_not_found");

  // 2. Insert, at most once for this attempt.
  const { data: requested, error: requestError } = await deps.admin.rpc(
    "calendar_outbound_mark_creation_requested",
    authority,
  );
  if (requestError) throw databaseException(requestError);
  if (!requested) return "superseded";

  let token;
  try {
    token = await getAccessToken(deps, claim.connectionId, {
      generation: claim.credentialGeneration,
      deadline,
    });
  } catch (error) {
    // Nothing was sent.
    if (stale(error)) return "superseded";
    return fail("definite", "token_unavailable");
  }
  try {
    const created = await provider.createCalendar(
      token,
      {
        summary: `Rendez-vous — ${claim.businessName}`,
        description: bookingCalendarDescription(claim.marker, claim.nonce),
        timeZone: claim.timezone,
      },
      { deadline },
    );
    return adopt(created.id, true);
  } catch (error) {
    if (!(error instanceof CalendarProviderError)) {
      return fail("ambiguous", "internal");
    }
    if (error.kind === "forbidden") return fail("forbidden", error.kind);
    // Refused before any processing: nothing was created.
    const refused =
      error.status !== null &&
      error.status < 500 &&
      ["unauthorized", "bad_request", "rate_limited", "not_found"].includes(
        error.kind,
      );
    return fail(refused ? "definite" : "ambiguous", error.kind);
  }
}

export type MirrorClaim = {
  appointmentId: string;
  businessId: string;
  claimId: string;
  generation: string;
  connectionId: string;
  credentialGeneration: string;
  revision: number;
  eventId: string;
  targetCalendarId: string;
  previousCalendarId: string | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  serviceName: string | null;
  clientFirstName: string | null;
  /** The repair generation captured with the claim (acknowledged on success). */
  repairGeneration: number;
  /** Reconciliation found the event different from Booking: repair it. */
  repair: boolean;
};

type MirrorOutcome =
  | { kind: "applied" }
  | { kind: "retry"; code: string; rateLimited?: boolean }
  | {
      kind: "action_required";
      code: "calendar_deleted" | "write_authorization_required";
    }
  /** No authority any more (reconnected, disconnected, expired grant). */
  | { kind: "halt" };

const isKind = (error: unknown, ...kinds: string[]) =>
  error instanceof CalendarProviderError && kinds.includes(error.kind);

async function applyMirror(
  deps: CalendarDeps,
  claim: MirrorClaim,
  deadline: number,
): Promise<MirrorOutcome> {
  const provider = deps.provider(PROVIDER);
  const callOptions = { deadline };
  const target = claim.targetCalendarId;

  try {
    return await withAccessToken(
      deps,
      claim.connectionId,
      async (token): Promise<MirrorOutcome> => {
        const calendarGone = async () =>
          !(await provider.calendarExists(token, target, callOptions));

        if (!claim.active) {
          // Never written to this calendar (cancelled before any attempt,
          // or recorded for a former calendar): nothing to remove. Unless
          // reconciliation listed the event there (a repair): the
          // deterministic id of an absent appointment is removed.
          if (claim.previousCalendarId !== target && !claim.repair) {
            return { kind: "applied" };
          }
          const existed = await provider.deleteEvent(
            token,
            target,
            claim.eventId,
            callOptions,
          );
          if (!existed && (await calendarGone())) {
            return { kind: "action_required", code: "calendar_deleted" };
          }
          return { kind: "applied" };
        }

        const event = outboundEvent(claim);
        // An event that exists under the deterministic id: only the
        // managed fields are written (partial update), whatever the
        // professional added stays. Deleted at Google (the patch leaves it
        // cancelled, or Google answers 410): the dedicated restoration, a
        // full rewrite of the canonical event. Never a read first.
        // "missing": the id does not exist (never written, or purged).
        const writeExisting = async (): Promise<"written" | "missing"> => {
          try {
            const { status } = await provider.patchEvent(
              token,
              target,
              event,
              callOptions,
            );
            if (status !== "cancelled") return "written";
          } catch (error) {
            if (isKind(error, "not_found")) return "missing";
            if (!isKind(error, "gone")) throw error;
          }
          try {
            await provider.restoreEvent(token, target, event, callOptions);
            return "written";
          } catch (error) {
            if (isKind(error, "not_found", "gone")) return "missing";
            throw error;
          }
        };

        // Possibly written before (a lost answer included): update first.
        if (claim.previousCalendarId === target) {
          if ((await writeExisting()) === "written") {
            return { kind: "applied" };
          }
        }
        try {
          await provider.insertEvent(token, target, event, callOptions);
          return { kind: "applied" };
        } catch (error) {
          // The deterministic id exists (an insert whose answer was lost,
          // or a deleted event): it is reconciled, never duplicated.
          if (isKind(error, "conflict")) {
            if ((await writeExisting()) === "written") {
              return { kind: "applied" };
            }
            // Gone between the two answers: the next attempt inserts.
            return { kind: "retry", code: "conflict" };
          }
          if (isKind(error, "not_found") && (await calendarGone())) {
            return { kind: "action_required", code: "calendar_deleted" };
          }
          throw error;
        }
      },
      { generation: claim.credentialGeneration, deadline },
    );
  } catch (error) {
    if (
      error instanceof StaleCredentialsError ||
      (error instanceof AppException &&
        (error.code === "calendar_reauth_required" ||
          error.code === "calendar_not_connected"))
    ) {
      return { kind: "halt" };
    }
    if (error instanceof CalendarProviderError) {
      // Calendars the app did not create, or the scope is gone: the whole
      // configuration needs the professional, not this one appointment.
      if (error.kind === "forbidden") {
        return {
          kind: "action_required",
          code: "write_authorization_required",
        };
      }
      return {
        kind: "retry",
        code: error.kind,
        rateLimited: error.kind === "rate_limited",
      };
    }
    return { kind: "retry", code: "internal" };
  }
}

export type OutboundRunResult = {
  creations: number;
  applied: number;
  retried: number;
  superseded: number;
  actionRequired: number;
  /** Appointments enrolled by the backfill (periodic job only). */
  backfilled: number;
  /** Calendars whose listing completed in this run. */
  reconciled: number;
  /** Drifts recorded as repairs in this run. */
  drifted: number;
};

/**
 * Share of outbound's time reserved to writes (due mirrors and repairs)
 * in the periodic job; reconciliation has at least the rest. Either side
 * borrows what the other leaves unused: reconciliation starts as soon as
 * no write is due, and writes resume after reconciliation if time is left.
 */
export const OUTBOUND_WRITE_SHARE = 0.75;

/**
 * The slice reserved for reconciliation is at least what a pass needs to
 * start (RECONCILIATION_MIN_START_MS) plus the scheduling slack between the
 * priority deadline and its first check: a reserved slice is never one it
 * refuses. Derived, never a second number to keep in step.
 */
export const RECONCILIATION_RESERVE_MS = RECONCILIATION_MIN_START_MS + 500;

/**
 * How an outbound budget of the periodic job is split. Writes have
 * priority for OUTBOUND_WRITE_SHARE of it; reconciliation keeps the rest,
 * raised to RECONCILIATION_RESERVE_MS when the budget can hold that next to
 * a write. A budget too small for both reserves nothing: writes keep their
 * priority and reconciliation only gets what they leave (it starts only
 * with RECONCILIATION_MIN_START_MS left).
 */
export function outboundPhases(budget: number) {
  const share = Math.floor(budget * (1 - OUTBOUND_WRITE_SHARE));
  const reconciliationMs =
    budget >= MIN_WRITE_MS + RECONCILIATION_RESERVE_MS
      ? Math.max(share, RECONCILIATION_RESERVE_MS)
      : share;
  return { priorityMs: budget - reconciliationMs, reconciliationMs };
}

/** Mirrors claimed per batch by the periodic job (at most 3 of one
 * business), so that what a deadline leaves unprocessed is a few claims
 * (released), and businesses alternate. */
const CLAIM_BATCH = 10;
/**
 * Time a write needs left in its phase to be started (each provider call is
 * bounded by the phase's deadline anyway): a short priority phase still
 * writes, instead of leaving its whole slice unused.
 */
const MIN_WRITE_MS = 1500;
const CLAIM_PER_BUSINESS = 3;

/**
 * Applies due mirrors (revisions and repairs), claimed fairly across
 * businesses in small batches, until none is due, `limit` were claimed, or
 * `deadline`. A configuration-level failure stops the business at once
 * (action required): its other mirrors are not tried, nor retried one by
 * one. Returns whether it stopped for lack of time with work left.
 */
async function applyDueMirrors(
  deps: CalendarDeps,
  result: OutboundRunResult,
  state: { claimed: number; stopped: Set<string> },
  options: {
    businessId?: string;
    limit: number;
    deadline: number;
    /**
     * Batches until nothing was due by then (ISO, the periodic job: never
     * what the run itself made due). null: one claim of everything due now
     * (a kick after a change: the change is due by the database's clock).
     */
    dueBefore: string | null;
    /** Aborted at the phase's or the run's deadline. */
    signal?: AbortSignal;
  },
) {
  const aborted = () => options.signal?.aborted === true;
  while (state.claimed < options.limit) {
    if (aborted() || options.deadline - Date.now() < MIN_WRITE_MS) return true;
    // Aborted with the phase: a claim granted late is never used (its lease
    // expires and the mirror is claimed again).
    const { data, error } = await abortable(
      deps.admin.rpc("calendar_outbound_claim_mirrors", {
        p_limit: options.dueBefore
          ? Math.min(CLAIM_BATCH, options.limit - state.claimed)
          : options.limit,
        p_business_id: (options.businessId ?? null) as string,
        p_per_business: options.dueBefore ? CLAIM_PER_BUSINESS : 10,
        p_exclude: [...state.stopped],
        p_due_before: options.dueBefore as string,
      }),
      options.signal,
    );
    if (error) throw databaseException(error);
    const claims = (data ?? []) as MirrorClaim[];
    if (claims.length === 0) return false;
    state.claimed += claims.length;

    // Businesses stopped in this run (action required, no authority, rate
    // limited) and claims the time left cannot cover: released untouched,
    // available to the next run at once.
    const release = (claim: MirrorClaim) =>
      abortable(
        deps.admin.rpc("calendar_outbound_release_mirror", {
          p_appointment_id: claim.appointmentId,
          p_claim_id: claim.claimId,
        }),
        options.signal,
      );
    for (const [index, claim] of claims.entries()) {
      if (state.stopped.has(claim.businessId)) {
        await release(claim);
        continue;
      }
      if (aborted() || options.deadline - Date.now() < MIN_WRITE_MS) {
        if (!aborted()) {
          for (const left of claims.slice(index)) await release(left);
        }
        return true;
      }
      const outcome = await applyMirror(
        deps,
        claim,
        Math.min(options.deadline, Date.now() + 20_000),
      );

      if (outcome.kind === "applied") {
        const { data: done, error: doneError } = await deps.admin.rpc(
          "calendar_outbound_complete_mirror",
          {
            p_appointment_id: claim.appointmentId,
            p_claim_id: claim.claimId,
            p_revision: claim.revision,
            p_repair_generation: claim.repairGeneration,
          },
        );
        if (doneError) throw databaseException(doneError);
        if (done === "applied") result.applied += 1;
        else {
          result.superseded += 1;
          logCalendar("outbound_mirror_superseded", {
            businessId: claim.businessId,
            appointmentId: claim.appointmentId,
          });
        }
      } else if (outcome.kind === "retry") {
        await deps.admin.rpc("calendar_outbound_fail_mirror", {
          p_appointment_id: claim.appointmentId,
          p_claim_id: claim.claimId,
          p_error: outcome.code,
        });
        result.retried += 1;
        logCalendar(
          "outbound_mirror_failed",
          {
            businessId: claim.businessId,
            appointmentId: claim.appointmentId,
            code: outcome.code,
          },
          "warn",
        );
        if (outcome.rateLimited) state.stopped.add(claim.businessId);
      } else if (outcome.kind === "action_required") {
        state.stopped.add(claim.businessId);
        const { data: marked } = await deps.admin.rpc(
          "calendar_outbound_mark_action_required",
          {
            p_appointment_id: claim.appointmentId,
            p_claim_id: claim.claimId,
            p_action_code: outcome.code,
          },
        );
        if (!marked) {
          // A stale worker's late answer: no authority, nothing changed.
          result.superseded += 1;
        } else {
          result.actionRequired += 1;
          logCalendar(
            "outbound_action_required",
            { businessId: claim.businessId, code: outcome.code },
            "warn",
          );
        }
      } else {
        state.stopped.add(claim.businessId);
        result.superseded += 1;
      }
    }
    if (!options.dueBefore) return false;
  }
  return false;
}

/** A database call aborted with `signal`; never started once it is aborted. */
function abortable<T extends { abortSignal(signal: AbortSignal): T }>(
  query: T,
  signal: AbortSignal | undefined,
) {
  return signal ? query.abortSignal(signal) : query;
}

/** Aborted when either is (the phase's own deadline, or the run's). */
function either(phase: AbortSignal | undefined, run: AbortSignal | undefined) {
  if (!phase) return run;
  return run ? AbortSignal.any([phase, run]) : phase;
}

/**
 * Processes due outbound work, within a budget: dedicated calendars to
 * create, then due mirrors. From the periodic job (no `businessId`), also
 * the backfill and reconciliation, in two phases with real deadlines:
 *
 * 1. priority: creations, backfill (local enrollment, so that what it
 *    enrolls is written in the same run) and due writes, for
 *    outboundPhases(budget).priorityMs (OUTBOUND_WRITE_SHARE of the
 *    budget, less if needed to reserve a slice reconciliation can start
 *    in). The deadline covers every await
 *    of the phase, database calls included: at the deadline the phase's
 *    signal is aborted and the run stops waiting for it (a late answer or
 *    failure is consumed, never an unhandled rejection). What lands late
 *    is harmless: claims expire and every recorded outcome is a
 *    compare-and-set under the claim's authority;
 * 2. reconciliation, guaranteed the rest of the budget;
 * 3. writes again with whatever reconciliation leaves, if the priority
 *    phase was cut short or repairs were just recorded.
 *
 * A failed write phase is logged and never skips reconciliation.
 * Nothing new starts once `signal` is aborted (the periodic job's deadline).
 */
export async function processOutbound(
  deps: CalendarDeps,
  options: {
    businessId?: string;
    budgetMs?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<OutboundRunResult> {
  const budget = options.budgetMs ?? 25_000;
  const start = Date.now();
  const deadline = start + budget;
  const aborted = () => options.signal?.aborted === true;
  const result: OutboundRunResult = {
    creations: 0,
    applied: 0,
    retried: 0,
    superseded: 0,
    actionRequired: 0,
    backfilled: 0,
    reconciled: 0,
    drifted: 0,
  };
  const writes = { claimed: 0, stopped: new Set<string>() };
  const limit = options.limit ?? 50;

  const createCalendars = async (
    businessIds: string[],
    until: number,
    signal: AbortSignal | undefined,
  ) => {
    for (const businessId of businessIds) {
      if (signal?.aborted || until - Date.now() < 5000) break;
      const outcome = await ensureOutboundCalendar(deps, businessId, {
        deadline: Math.min(until, Date.now() + 20_000),
      });
      if (outcome !== "busy") result.creations += 1;
      if (outcome === "action_required") result.actionRequired += 1;
    }
  };

  if (options.businessId) {
    // A kick after a change: its own business only, one claim.
    await createCalendars([options.businessId], deadline, options.signal);
    if (aborted()) return result;
    await applyDueMirrors(deps, result, writes, {
      businessId: options.businessId,
      limit,
      deadline,
      dueBefore: null,
      signal: options.signal,
    });
    return result;
  }

  const priorityDeadline = start + outboundPhases(budget).priorityMs;
  // A phase run with a real deadline; true when it was cut short. Which
  // came first is said by withinDeadline, never inferred from the clock:
  // the phase's deadline is expected (a warning), a real failure is an
  // error even when it happens a millisecond before the deadline. A
  // failure never takes reconciliation's turn: what the phase left undone
  // stays due for the next run. When the run itself was abandoned (its
  // parent signal aborted at the periodic job's deadline), whatever fails
  // afterwards is that abandonment, already reported by the job.
  const phase = (
    until: number,
    run: (signal?: AbortSignal) => Promise<boolean>,
  ) =>
    withinDeadline(until, (signal) => run(either(signal, options.signal))).then(
      (outcome) => {
        if (!outcome.expired) return outcome.value;
        logCalendar("outbound_phase_deadline_exceeded", {}, "warn");
        return true;
      },
      (error: unknown) => {
        if (!aborted()) {
          logCalendar(
            "outbound_writes_failed",
            { code: error instanceof AppException ? error.code : "internal" },
            "error",
          );
        }
        return true;
      },
    );

  const cut = await phase(priorityDeadline, async (signal) => {
    const { data, error } = await abortable(
      deps.admin.rpc("calendar_outbound_due_creations", { p_limit: 20 }),
      signal,
    );
    if (error) throw databaseException(error);
    await createCalendars(
      (data ?? []).map((row) => row.business_id),
      priorityDeadline,
      signal,
    );
    if (signal?.aborted) return true;
    result.backfilled = await backfillOutbound(deps, signal);
    return applyDueMirrors(deps, result, writes, {
      limit,
      deadline: priorityDeadline,
      dueBefore: new Date().toISOString(),
      signal,
    });
  });
  if (aborted()) return result;

  const reconciliation = await reconcileOutbound(deps, {
    deadline,
    signal: options.signal,
  });
  result.reconciled = reconciliation.reconciled;
  result.drifted = reconciliation.drifted;
  result.actionRequired += reconciliation.actionRequired;

  // Writes cut short by their share, or repairs just recorded: the time
  // reconciliation left is theirs.
  if ((cut || reconciliation.drifted > 0) && !aborted()) {
    await phase(deadline, (signal) =>
      applyDueMirrors(deps, result, writes, {
        limit,
        deadline,
        dueBefore: new Date().toISOString(),
        signal,
      }),
    );
  }
  return result;
}
