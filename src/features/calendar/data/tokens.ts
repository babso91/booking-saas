import "server-only";

import {
  CalendarProviderError,
  type CalendarProviderId,
} from "@/features/calendar/providers/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";

import { tokenAad, type CalendarDeps } from "./deps";
import { logCalendar } from "./log";

// The one place that hands out provider access tokens. A stored token is
// reused while it has more than a minute left; otherwise it is refreshed once
// per connection and process (concurrent callers share the same refresh, no
// stampede). Across processes two refreshes may happen: harmless, Google
// keeps the refresh token valid and both access tokens work.

const EARLY_REFRESH_MS = 60_000;
const inflight = new Map<string, Promise<string>>();

export type ConnectionSecrets = {
  businessId: string;
  provider: CalendarProviderId;
  status: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
};

export async function readConnectionSecrets(
  deps: CalendarDeps,
  connectionId: string,
): Promise<ConnectionSecrets | null> {
  const { data, error } = await deps.admin.rpc("calendar_read_secrets", {
    p_connection_id: connectionId,
  });
  if (error) throw databaseException(error);
  const row = data?.[0];
  if (!row) return null;

  const aad = tokenAad(row.business_id, row.provider);
  return {
    businessId: row.business_id,
    provider: row.provider as CalendarProviderId,
    status: row.status,
    refreshToken: decryptSecret(row.refresh_token_ciphertext, aad, deps.keys),
    accessToken: row.access_token_ciphertext
      ? decryptSecret(row.access_token_ciphertext, aad, deps.keys)
      : null,
    accessTokenExpiresAt: row.access_token_expires_at
      ? new Date(row.access_token_expires_at)
      : null,
  };
}

/** Marks the connection as needing the professional again (token revoked). */
export async function markReauthRequired(
  deps: CalendarDeps,
  connectionId: string,
  code: string,
) {
  await deps.admin.rpc("calendar_mark_reauth_required", {
    p_connection_id: connectionId,
    p_error: code,
  });
  logCalendar("reauth_required", { connectionId, code }, "warn");
}

async function refresh(
  deps: CalendarDeps,
  connectionId: string,
  secrets: ConnectionSecrets,
) {
  try {
    const fresh = await deps
      .provider(secrets.provider)
      .refreshAccessToken(secrets.refreshToken);
    const { error } = await deps.admin.rpc("calendar_store_access_token", {
      p_connection_id: connectionId,
      p_access_token_ciphertext: encryptSecret(
        fresh.accessToken,
        tokenAad(secrets.businessId, secrets.provider),
        deps.keys[0]!,
      ),
      p_access_token_expires_at: fresh.expiresAt.toISOString(),
    });
    if (error) throw databaseException(error);
    logCalendar("token_refreshed", {
      connectionId,
      provider: secrets.provider,
    });
    return fresh.accessToken;
  } catch (error) {
    if (
      error instanceof CalendarProviderError &&
      error.kind === "auth_revoked"
    ) {
      await markReauthRequired(deps, connectionId, "invalid_grant");
      throw new AppException("calendar_reauth_required", { cause: error });
    }
    throw error;
  }
}

/**
 * A valid access token for an active connection. `forceRefresh` after the
 * provider rejected the stored one (401).
 */
export async function getAccessToken(
  deps: CalendarDeps,
  connectionId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const secrets = await readConnectionSecrets(deps, connectionId);
  if (!secrets) throw new AppException("calendar_not_connected");
  if (secrets.status !== "active") {
    throw new AppException(
      secrets.status === "reauth_required"
        ? "calendar_reauth_required"
        : "calendar_not_connected",
    );
  }

  if (
    !options.forceRefresh &&
    secrets.accessToken &&
    secrets.accessTokenExpiresAt &&
    secrets.accessTokenExpiresAt.getTime() - Date.now() > EARLY_REFRESH_MS
  ) {
    return secrets.accessToken;
  }

  const running = inflight.get(connectionId);
  if (running) return running;

  const pending = refresh(deps, connectionId, secrets).finally(() =>
    inflight.delete(connectionId),
  );
  inflight.set(connectionId, pending);
  return pending;
}

/** Runs a provider call with a valid token, refreshing once after a 401. */
export async function withAccessToken<T>(
  deps: CalendarDeps,
  connectionId: string,
  run: (accessToken: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(await getAccessToken(deps, connectionId));
  } catch (error) {
    if (
      error instanceof CalendarProviderError &&
      error.kind === "unauthorized"
    ) {
      return run(
        await getAccessToken(deps, connectionId, { forceRefresh: true }),
      );
    }
    throw error;
  }
}

/** Provider failures as stable application errors. */
export function toCalendarException(error: unknown): unknown {
  if (error instanceof CalendarProviderError) {
    if (error.kind === "auth_revoked" || error.kind === "unauthorized") {
      return new AppException("calendar_reauth_required", { cause: error });
    }
    return new AppException("calendar_provider_unavailable", { cause: error });
  }
  return error;
}
