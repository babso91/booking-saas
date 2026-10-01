import "server-only";

import type { CalendarProviderId } from "@/features/calendar/providers/types";
import {
  decryptSecret,
  encryptSecret,
  randomToken,
  sha256Hex,
} from "@/lib/crypto/secret-box";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import { stopChannels } from "./channels";
import { tokenAad, type CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { syncCalendar, type SyncOutcome } from "./sync";
import { toCalendarException, withAccessToken } from "./tokens";

// Connection lifecycle of the professional's external calendar. Every entry
// point receives the tenant resolved from the session (never from input):
// reads go through the user's client (RLS), privileged writes through the
// service role after the membership was checked in SQL.

export type CalendarContext = {
  client: AppSupabaseClient;
  userId: string;
  businessId: string;
};

const PROVIDER: CalendarProviderId = "google";

export type ConnectedCalendarDto = {
  id: string;
  name: string;
  timezone: string | null;
  primary: boolean;
  accessRole: string | null;
  blocking: boolean;
  syncStatus: "idle" | "pending" | "error";
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type CalendarIntegrationStatusDto = {
  provider: CalendarProviderId;
  /** False when the server has no calendar configuration. */
  available: boolean;
  connection: {
    id: string;
    status: "active" | "reauth_required" | "disconnected";
    accountEmail: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
    version: number;
  } | null;
  calendars: ConnectedCalendarDto[];
};

const verifierAad = (stateHash: string) => `oauth-verifier:${stateHash}`;

async function connectionOf(context: CalendarContext) {
  const { data, error } = await context.client
    .from("calendar_connections")
    .select("id, status, account_email, last_synced_at, last_error, version")
    .eq("business_id", context.businessId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw databaseException(error);
  return data;
}

async function activeConnectionId(context: CalendarContext) {
  const connection = await connectionOf(context);
  if (!connection || connection.status === "disconnected") {
    throw new AppException("calendar_not_connected");
  }
  if (connection.status === "reauth_required") {
    throw new AppException("calendar_reauth_required");
  }
  return connection.id;
}

export async function listConnectedCalendars(
  context: CalendarContext,
): Promise<ConnectedCalendarDto[]> {
  const { data, error } = await context.client
    .from("external_calendars")
    .select(
      "id, name, timezone, is_primary, access_role, selected_for_blocking, sync_status, last_synced_at, last_error",
    )
    .eq("business_id", context.businessId)
    .order("is_primary", { ascending: false })
    .order("name")
    .limit(251);
  if (error) throw databaseException(error);
  return data.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    primary: row.is_primary,
    accessRole: row.access_role,
    blocking: row.selected_for_blocking,
    syncStatus: row.sync_status as ConnectedCalendarDto["syncStatus"],
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  }));
}

export async function getCalendarIntegrationStatus(
  context: CalendarContext,
  available: boolean,
): Promise<CalendarIntegrationStatusDto> {
  const connection = await connectionOf(context);
  const active = connection && connection.status !== "disconnected";
  return {
    provider: PROVIDER,
    available,
    connection: connection
      ? {
          id: connection.id,
          status: connection.status as
            "active" | "reauth_required" | "disconnected",
          accountEmail: active ? connection.account_email : null,
          lastSyncedAt: connection.last_synced_at,
          lastError: connection.last_error,
          version: connection.version,
        }
      : null,
    calendars: active ? await listConnectedCalendars(context) : [],
  };
}

/**
 * Starts an OAuth connection: a random state (only its hash is stored, bound
 * to this user and business, 10 minutes, single use) and a PKCE verifier
 * (stored encrypted). Returns the provider URL to open.
 */
export async function startConnect(
  context: CalendarContext,
  deps: CalendarDeps,
) {
  const state = randomToken(32);
  const stateHash = sha256Hex(state);
  const codeVerifier = randomToken(48);
  const codeChallenge = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier),
    ),
  ).toString("base64url");

  const { error } = await context.client.rpc("calendar_begin_oauth", {
    p_business_id: context.businessId,
    p_provider: PROVIDER,
    p_state_hash: stateHash,
    p_code_verifier_ciphertext: encryptSecret(
      codeVerifier,
      verifierAad(stateHash),
      deps.keys[0]!,
    ),
  });
  if (error) throw databaseException(error);

  return {
    authorizationUrl: deps.provider(PROVIDER).authorizationUrl({
      state,
      codeChallenge,
      redirectUri: deps.env.GOOGLE_CALENDAR_REDIRECT_URI,
    }),
  };
}

/**
 * Completes the OAuth callback for the signed-in user. Nothing is stored
 * unless every step succeeds: state consumed (same user, not expired, never
 * used), same business as the session, code exchanged, scopes granted,
 * calendars listed; then connection, credentials and calendars are saved in
 * one transaction. Returns the calendars to sync again (reconnection).
 */
export async function completeConnect(
  context: CalendarContext,
  deps: CalendarDeps,
  input: { state: string; code: string },
) {
  const stateHash = sha256Hex(input.state);
  const { data: consumed, error } = await context.client.rpc(
    "calendar_consume_oauth_state",
    { p_state_hash: stateHash },
  );
  if (error) throw databaseException(error);
  const row = consumed?.[0];
  if (!row) throw new AppException("oauth_state_invalid");
  // The session must still be on the business the state was issued for.
  if (row.business_id !== context.businessId) {
    throw new AppException("oauth_state_invalid");
  }

  const provider = deps.provider(row.provider as CalendarProviderId);
  const codeVerifier = decryptSecret(
    row.code_verifier_ciphertext,
    verifierAad(stateHash),
    deps.keys,
  );

  let tokens;
  let calendars;
  try {
    tokens = await provider.exchangeCode({
      code: input.code,
      codeVerifier,
      redirectUri: deps.env.GOOGLE_CALENDAR_REDIRECT_URI,
    });
    if (
      !provider.requiredScopes.every((scope) => tokens!.scopes.includes(scope))
    ) {
      throw new AppException("calendar_scope_missing");
    }
    calendars = await provider.listCalendars(tokens.accessToken);
  } catch (error) {
    throw toCalendarException(error);
  }

  const aad = tokenAad(context.businessId, provider.id);
  const { data: connectionId, error: saveError } = await deps.admin.rpc(
    "calendar_save_connection",
    {
      p_business_id: context.businessId,
      p_user_id: context.userId,
      p_provider: provider.id,
      p_provider_account_id: tokens.account.id,
      p_account_email: tokens.account.email as string,
      p_scopes: tokens.scopes,
      // null: Google sent no new refresh token (kept for the same account).
      p_refresh_token_ciphertext: (tokens.refreshToken
        ? encryptSecret(tokens.refreshToken, aad, deps.keys[0]!)
        : null) as string,
      p_access_token_ciphertext: encryptSecret(
        tokens.accessToken,
        aad,
        deps.keys[0]!,
      ),
      p_access_token_expires_at: tokens.expiresAt.toISOString(),
      p_calendars: calendars.map((calendar) => ({
        id: calendar.id,
        name: calendar.name,
        timezone: calendar.timezone,
        primary: calendar.primary,
        accessRole: calendar.accessRole,
      })),
    },
  );
  if (saveError) throw databaseException(saveError);

  logCalendar("connected", {
    businessId: context.businessId,
    connectionId: connectionId as string,
    provider: provider.id,
    count: calendars.length,
  });
  return { connectionId: connectionId as string };
}

/** Re-reads the calendar list from the provider. */
export async function refreshCalendars(
  context: CalendarContext,
  deps: CalendarDeps,
) {
  const connectionId = await activeConnectionId(context);
  let calendars;
  try {
    calendars = await withAccessToken(deps, connectionId, (token) =>
      deps.provider(PROVIDER).listCalendars(token),
    );
  } catch (error) {
    throw toCalendarException(error);
  }
  const { error } = await deps.admin.rpc("calendar_save_calendars", {
    p_connection_id: connectionId,
    p_calendars: calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      timezone: calendar.timezone,
      primary: calendar.primary,
      accessRole: calendar.accessRole,
    })),
  });
  if (error) throw databaseException(error);
  return listConnectedCalendars(context);
}

/**
 * Replaces the blocking selection (one transaction, schedule lock). Returns
 * the calendars to sync; the caller syncs them (after the response) and the
 * channels of deselected calendars are stopped.
 */
export async function setBlockingCalendars(
  context: CalendarContext,
  deps: CalendarDeps,
  calendarIds: string[],
) {
  const { data, error } = await context.client.rpc("calendar_set_blocking", {
    p_business_id: context.businessId,
    p_calendar_ids: calendarIds,
  });
  if (error) throw databaseException(error);
  const result = data as {
    connectionId: string;
    toSync: string[];
    channelsToStop: { channelId: string; resourceId: string }[];
  };
  return {
    calendars: await listConnectedCalendars(context),
    toSync: result.toSync,
    cleanup: () =>
      stopChannels(
        deps,
        result.connectionId,
        PROVIDER,
        result.channelsToStop.map((channel) => ({
          id: channel.channelId,
          resourceId: channel.resourceId,
        })),
      ),
  };
}

/** Synchronises every blocking calendar now, within a time budget. */
export async function syncNow(
  context: CalendarContext,
  deps: CalendarDeps,
  budgetMs = 20_000,
) {
  await activeConnectionId(context);
  const calendars = await listConnectedCalendars(context);
  const deadline = Date.now() + budgetMs;
  const outcomes: Record<string, SyncOutcome> = {};
  for (const calendar of calendars.filter((item) => item.blocking)) {
    const remaining = deadline - Date.now();
    outcomes[calendar.id] =
      remaining > 1000
        ? await syncCalendar(deps, calendar.id, { budgetMs: remaining })
        : "budget_exceeded";
  }
  return { outcomes, calendars: await listConnectedCalendars(context) };
}

/**
 * Disconnects: locally first, at once (busy periods, calendars, cursors and
 * credentials deleted; appointments untouched), then best effort at the
 * provider (channels stopped, grant revoked). Idempotent.
 */
export async function disconnect(context: CalendarContext, deps: CalendarDeps) {
  const connection = await connectionOf(context);
  if (!connection || connection.status === "disconnected")
    return { disconnected: true };

  const { data, error } = await deps.admin.rpc("calendar_disconnect", {
    p_connection_id: connection.id,
  });
  if (error) throw databaseException(error);
  const removed = data as {
    provider: CalendarProviderId;
    refreshTokenCiphertext?: string;
    accessTokenCiphertext?: string | null;
    accessTokenExpiresAt?: string | null;
    channels: { channelId: string; resourceId: string }[];
  } | null;

  logCalendar("disconnected", {
    businessId: context.businessId,
    connectionId: connection.id,
    provider: PROVIDER,
  });

  if (removed?.refreshTokenCiphertext) {
    const provider = deps.provider(removed.provider);
    const aad = tokenAad(context.businessId, removed.provider);
    try {
      const refreshToken = decryptSecret(
        removed.refreshTokenCiphertext,
        aad,
        deps.keys,
      );
      const accessToken =
        removed.accessTokenCiphertext &&
        removed.accessTokenExpiresAt &&
        new Date(removed.accessTokenExpiresAt).getTime() > Date.now() + 30_000
          ? decryptSecret(removed.accessTokenCiphertext, aad, deps.keys)
          : (await provider.refreshAccessToken(refreshToken)).accessToken;
      await stopChannels(
        deps,
        connection.id,
        removed.provider,
        removed.channels.map((channel) => ({
          id: channel.channelId,
          resourceId: channel.resourceId,
        })),
        accessToken,
      );
      // Revoking the refresh token revokes the whole grant at Google.
      await provider.revoke(refreshToken);
    } catch {
      logCalendar("revoke_failed", { connectionId: connection.id }, "warn");
    }
  }

  return { disconnected: true };
}

export type CalendarConflictDto = {
  appointmentId: string;
  appointmentStartsAt: string;
  appointmentEndsAt: string;
  calendarId: string;
  eventStartsAt: string;
  eventEndsAt: string;
};

/** Appointments overlapped by an external busy period (reported only). */
export async function listConflicts(
  context: CalendarContext,
  range: { from: string; to: string },
): Promise<CalendarConflictDto[]> {
  const { data, error } = await context.client.rpc("calendar_conflicts", {
    p_business_id: context.businessId,
    p_from: range.from,
    p_to: range.to,
  });
  if (error) throw databaseException(error);
  return data.map((row) => ({
    appointmentId: row.appointment_id,
    appointmentStartsAt: new Date(row.appointment_starts_at).toISOString(),
    appointmentEndsAt: new Date(row.appointment_ends_at).toISOString(),
    calendarId: row.external_calendar_id,
    eventStartsAt: new Date(row.event_starts_at).toISOString(),
    eventEndsAt: new Date(row.event_ends_at).toISOString(),
  }));
}
