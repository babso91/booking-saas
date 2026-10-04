import "server-only";

import { bookingCalendarDescription } from "@/features/calendar/providers/google";
import {
  CalendarProviderError,
  type CalendarProviderId,
  type OutboundEvent,
} from "@/features/calendar/providers/types";
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
import { StaleCredentialsError, withAccessToken } from "./tokens";

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
   * calendar was deleted: create a new one explicitly), enable_again (the
   * connection now uses another Google account).
   */
  actionRequired:
    "authorize_write" | "reconnect" | "reactivate" | "enable_again" | null;
  reason:
    | "calendar_deleted"
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
    reason = "calendar_deleted";
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
  businessName: string;
  timezone: string;
  requested: boolean;
};

/** The claim lost its authority between two steps: nothing is recorded. */
class SupersededError extends Error {}

export type CreationOutcome =
  "created" | "recovered" | "busy" | "superseded" | "retry" | "action_required";

/**
 * Creates the dedicated calendar, or finds it again. Idempotent across lost
 * answers: the calendar list is always searched for this configuration's
 * marker first (a creation whose answer was lost is adopted, never created
 * twice), and the creation itself is recorded before it is sent and never
 * retried automatically. One worker at a time per business (claim).
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

  try {
    const found = await withAccessToken(
      deps,
      claim.connectionId,
      async (token) => {
        const calendars = await provider.listCalendars(token, { deadline });
        const existing = calendars
          .filter((calendar) => calendar.bookingMarker === claim.marker)
          .map((calendar) => calendar.id)
          .sort()[0];
        if (existing) return { id: existing, created: false };

        const { data: requested, error: requestError } = await deps.admin.rpc(
          "calendar_outbound_mark_creation_requested",
          {
            p_business_id: businessId,
            p_claim_id: claim.claimId,
            p_generation: claim.generation,
          },
        );
        if (requestError) throw databaseException(requestError);
        if (!requested) throw new SupersededError();

        const created = await provider.createCalendar(
          token,
          {
            summary: `Rendez-vous — ${claim.businessName}`,
            description: bookingCalendarDescription(claim.marker),
            timeZone: claim.timezone,
          },
          { deadline },
        );
        return { id: created.id, created: true };
      },
      { generation: claim.credentialGeneration, deadline },
    );

    const { data: adopted, error: adoptError } = await deps.admin.rpc(
      "calendar_outbound_adopt_calendar",
      {
        p_business_id: businessId,
        p_claim_id: claim.claimId,
        p_generation: claim.generation,
        p_credential_generation: claim.credentialGeneration,
        p_provider_calendar_id: found.id,
      },
    );
    if (adoptError) throw databaseException(adoptError);
    if (!adopted) {
      logCalendar("outbound_calendar_superseded", { businessId }, "warn");
      return "superseded";
    }
    logCalendar(
      found.created
        ? "outbound_calendar_created"
        : "outbound_calendar_recovered",
      { businessId },
    );
    return found.created ? "created" : "recovered";
  } catch (error) {
    if (
      error instanceof SupersededError ||
      error instanceof StaleCredentialsError ||
      (error instanceof AppException &&
        (error.code === "calendar_reauth_required" ||
          error.code === "calendar_not_connected"))
    ) {
      return "superseded";
    }
    const forbidden =
      error instanceof CalendarProviderError && error.kind === "forbidden";
    const code =
      error instanceof CalendarProviderError ? error.kind : "internal";
    const { error: failError } = await deps.admin.rpc(
      "calendar_outbound_creation_failed",
      {
        p_business_id: businessId,
        p_claim_id: claim.claimId,
        p_generation: claim.generation,
        p_error: code,
        p_action_code: (forbidden
          ? "write_authorization_required"
          : null) as string,
      },
    );
    if (failError) throw databaseException(failError);
    logCalendar(
      "outbound_calendar_failed",
      { businessId, code },
      forbidden ? "warn" : "error",
    );
    return forbidden ? "action_required" : "retry";
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

/**
 * The event as Google shows it: canonical instants from PostgreSQL (no
 * conversion here), the service's end (never the buffer), a first name and
 * a service name. Private metadata identifies the mirror.
 */
export function outboundEvent(claim: MirrorClaim): OutboundEvent {
  const firstName = claim.clientFirstName?.trim();
  const service = claim.serviceName?.trim() || "Rendez-vous";
  return {
    id: claim.eventId,
    summary: (firstName ? `${firstName} — ${service}` : service).slice(0, 250),
    startsAt: claim.startsAt!,
    endsAt: claim.endsAt!,
    privateProperties: {
      origin: "booking-saas",
      appointmentId: claim.appointmentId,
      revision: String(claim.revision),
    },
  };
}

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
          // or recorded for a former calendar): nothing to remove.
          if (claim.previousCalendarId !== target) return { kind: "applied" };
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
        // Possibly written before (a lost answer included): update first.
        // A cancelled event comes back with status confirmed, same id.
        if (claim.previousCalendarId === target) {
          try {
            await provider.updateEvent(token, target, event, callOptions);
            return { kind: "applied" };
          } catch (error) {
            if (!isKind(error, "not_found", "gone")) throw error;
          }
        }
        try {
          await provider.insertEvent(token, target, event, callOptions);
          return { kind: "applied" };
        } catch (error) {
          // The deterministic id exists (an insert whose answer was lost,
          // or a deleted event): it is reconciled, never duplicated.
          if (isKind(error, "conflict")) {
            await provider.updateEvent(token, target, event, callOptions);
            return { kind: "applied" };
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
};

/**
 * Processes due outbound work, within a budget: dedicated calendars to
 * create, then due mirrors (claimed fairly across businesses). A
 * configuration-level failure stops the business at once (action
 * required): its other mirrors are not tried, nor retried one by one.
 */
export async function processOutbound(
  deps: CalendarDeps,
  options: { businessId?: string; budgetMs?: number; limit?: number } = {},
): Promise<OutboundRunResult> {
  const deadline = Date.now() + (options.budgetMs ?? 25_000);
  const result: OutboundRunResult = {
    creations: 0,
    applied: 0,
    retried: 0,
    superseded: 0,
    actionRequired: 0,
  };

  let creations: string[];
  if (options.businessId) {
    creations = [options.businessId];
  } else {
    const { data, error } = await deps.admin.rpc(
      "calendar_outbound_due_creations",
      { p_limit: 20 },
    );
    if (error) throw databaseException(error);
    creations = (data ?? []).map((row) => row.business_id);
  }
  for (const businessId of creations) {
    if (deadline - Date.now() < 5000) break;
    const outcome = await ensureOutboundCalendar(deps, businessId, {
      deadline: Math.min(deadline, Date.now() + 20_000),
    });
    if (outcome !== "busy") result.creations += 1;
    if (outcome === "action_required") result.actionRequired += 1;
  }

  const { data, error } = await deps.admin.rpc(
    "calendar_outbound_claim_mirrors",
    {
      p_limit: options.limit ?? 50,
      p_business_id: (options.businessId ?? null) as string,
      p_per_business: 10,
    },
  );
  if (error) throw databaseException(error);
  const claims = (data ?? []) as MirrorClaim[];

  // Businesses stopped in this run (action required, no authority, rate
  // limited): their remaining claims are left to expire, untouched.
  const stopped = new Set<string>();
  for (const claim of claims) {
    if (stopped.has(claim.businessId)) continue;
    if (deadline - Date.now() < 3000) break;
    const outcome = await applyMirror(
      deps,
      claim,
      Math.min(deadline, Date.now() + 20_000),
    );

    if (outcome.kind === "applied") {
      const { data: done, error: doneError } = await deps.admin.rpc(
        "calendar_outbound_complete_mirror",
        {
          p_appointment_id: claim.appointmentId,
          p_claim_id: claim.claimId,
          p_revision: claim.revision,
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
      if (outcome.rateLimited) stopped.add(claim.businessId);
    } else if (outcome.kind === "action_required") {
      stopped.add(claim.businessId);
      const { data: marked } = await deps.admin.rpc(
        "calendar_outbound_mark_action_required",
        {
          p_business_id: claim.businessId,
          p_generation: claim.generation,
          p_action_code: outcome.code,
        },
      );
      if (marked) {
        result.actionRequired += 1;
        logCalendar(
          "outbound_action_required",
          { businessId: claim.businessId, code: outcome.code },
          "warn",
        );
      }
    } else {
      stopped.add(claim.businessId);
      result.superseded += 1;
    }
  }
  return result;
}
