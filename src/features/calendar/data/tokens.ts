import "server-only";

import {
  CalendarProviderError,
  type CalendarProviderId,
} from "@/features/calendar/providers/types";
import {
  decryptSecret,
  encryptSecret,
  secretKeyId,
} from "@/lib/crypto/secret-box";
import { deadlineExceeded } from "@/features/calendar/providers/http";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";

import { tokenAad, type CalendarDeps } from "./deps";
import { logCalendar } from "./log";

// The one place that hands out provider access tokens.
//
// Incarnations: a connection's credentials belong to one incarnation
// (calendar_connections.credential_generation), replaced at every
// reconnection or disconnection. Every operation captures the generation
// first and every write it makes is conditional on it, in SQL: a refreshed
// token, an invalid_grant or a re-encryption of a former incarnation is a
// no-op, never applied to the account connected since.
//
// A stored token is reused while it has more than a minute left; otherwise it
// is refreshed once per (connection, incarnation) and process: concurrent
// callers of the same incarnation share the refresh, a caller of a newer
// incarnation never receives the token of a former one. Across processes two
// refreshes may happen: harmless, Google keeps the refresh token valid and
// both access tokens work.
//
// The shared refresh has its own budget (REFRESH_BUDGET_MS), independent of
// whoever started it, covering the provider call, the compare-and-set
// write and the release of the single-flight entry: the entry is always
// gone when the budget ends. Each caller bounds its own wait (reading the
// secrets included) by its deadline; a worker whose budget ends stops
// waiting, the refresh goes on for the others. Database waits are bounded
// in SQL too (lock_timeout on credential writes), and every write is
// compare-and-set, so a write the caller stopped waiting for either fails
// or lands harmlessly (a valid token of the same incarnation, with its own
// expiry).
//
// Every write is compare-and-set in SQL on the secrets row itself
// (incarnation, and secret_version for a re-encryption): a stale writer
// waiting on a lock writes nothing once the newer row is committed.

const EARLY_REFRESH_MS = 60_000;
const REFRESH_BUDGET_MS = 30_000;
const inflight = new Map<string, Promise<string>>();

/**
 * The incarnation an operation started with is gone (reconnection,
 * disconnection): the operation stops without writing anything.
 */
export class StaleCredentialsError extends Error {
  constructor() {
    super("Connection credentials changed");
    this.name = "StaleCredentialsError";
  }
}

export type TokenOptions = {
  /** The incarnation the operation captured; anything else is stale. */
  generation?: string;
  /** Absolute deadline (epoch ms) of the operation. */
  deadline?: number;
};

export type ConnectionSecrets = {
  businessId: string;
  provider: CalendarProviderId;
  status: string;
  generation: string;
  /** Version of the secrets row read (compare-and-set of re-encryption). */
  secretVersion: number;
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
  const secrets: ConnectionSecrets = {
    businessId: row.business_id,
    provider: row.provider as CalendarProviderId,
    status: row.status,
    generation: row.credential_generation,
    secretVersion: row.secret_version,
    refreshToken: decryptSecret(row.refresh_token_ciphertext, aad, deps.keys),
    accessToken: row.access_token_ciphertext
      ? decryptSecret(row.access_token_ciphertext, aad, deps.keys)
      : null,
    accessTokenExpiresAt: row.access_token_expires_at
      ? new Date(row.access_token_expires_at)
      : null,
  };

  // Lazy re-encryption after a key rotation: both secrets are rewritten
  // under the current key, only if the row is still exactly the one read
  // (incarnation and version): a token refreshed meanwhile always wins.
  const current = deps.keys[0]!.id;
  if (
    secretKeyId(row.refresh_token_ciphertext) !== current ||
    (row.access_token_ciphertext &&
      secretKeyId(row.access_token_ciphertext) !== current)
  ) {
    const { data: rewritten, error: rewriteError } = await deps.admin.rpc(
      "calendar_reencrypt_secrets",
      {
        p_connection_id: connectionId,
        p_generation: secrets.generation,
        p_secret_version: secrets.secretVersion,
        p_refresh_token_ciphertext: encryptSecret(
          secrets.refreshToken,
          aad,
          deps.keys[0]!,
        ),
        // null: no access token stored.
        p_access_token_ciphertext: (secrets.accessToken
          ? encryptSecret(secrets.accessToken, aad, deps.keys[0]!)
          : null) as string,
      },
    );
    // Opportunistic: a failed or refused re-encryption (lock timeout, newer
    // secrets) never fails the read; the next read tries again.
    if (rewriteError) {
      logCalendar(
        "secrets_reencrypt_failed",
        { connectionId, code: rewriteError.code },
        "warn",
      );
    } else if (rewritten) {
      logCalendar("secrets_reencrypted", { connectionId });
    }
  }
  return secrets;
}

/** The connection's current incarnation (null: no such connection). */
export async function currentGeneration(
  deps: CalendarDeps,
  connectionId: string,
): Promise<string | null> {
  const { data, error } = await deps.admin
    .from("calendar_connections")
    .select("credential_generation")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw databaseException(error);
  return data?.credential_generation ?? null;
}

/**
 * Marks the connection as needing the professional again (token revoked),
 * only if `generation` is still its incarnation. Returns false otherwise
 * (the invalid_grant belonged to former credentials).
 */
export async function markReauthRequired(
  deps: CalendarDeps,
  connectionId: string,
  generation: string,
  code: string,
) {
  const { data, error } = await deps.admin.rpc(
    "calendar_mark_reauth_required",
    {
      p_connection_id: connectionId,
      p_generation: generation,
      p_error: code,
    },
  );
  if (error) throw databaseException(error);
  if (data) logCalendar("reauth_required", { connectionId, code }, "warn");
  return Boolean(data);
}

async function refresh(
  deps: CalendarDeps,
  connectionId: string,
  secrets: ConnectionSecrets,
  deadline: number,
) {
  let fresh;
  try {
    fresh = await deps
      .provider(secrets.provider)
      .refreshAccessToken(secrets.refreshToken, { deadline });
  } catch (error) {
    if (
      error instanceof CalendarProviderError &&
      error.kind === "auth_revoked"
    ) {
      if (
        await markReauthRequired(
          deps,
          connectionId,
          secrets.generation,
          "invalid_grant",
        )
      ) {
        throw new AppException("calendar_reauth_required", { cause: error });
      }
      // The revoked grant was a former incarnation's.
      throw new StaleCredentialsError();
    }
    throw error;
  }

  const { data: stored, error } = await deps.admin.rpc(
    "calendar_store_access_token",
    {
      p_connection_id: connectionId,
      p_generation: secrets.generation,
      p_access_token_ciphertext: encryptSecret(
        fresh.accessToken,
        tokenAad(secrets.businessId, secrets.provider),
        deps.keys[0]!,
      ),
      p_access_token_expires_at: fresh.expiresAt.toISOString(),
    },
  );
  if (error) throw databaseException(error);
  // Reconnected or disconnected while refreshing: the token is of a former
  // incarnation, neither stored nor used.
  if (!stored) throw new StaleCredentialsError();

  logCalendar("token_refreshed", { connectionId, provider: secrets.provider });
  return fresh.accessToken;
}

/**
 * A valid access token for an active connection, of the incarnation the
 * caller started with (`generation`). `forceRefresh` after the provider
 * rejected the stored one (401).
 */
export async function getAccessToken(
  deps: CalendarDeps,
  connectionId: string,
  options: TokenOptions & { forceRefresh?: boolean } = {},
): Promise<string> {
  const secrets = await awaitWithDeadline(
    readConnectionSecrets(deps, connectionId),
    options.deadline,
  );
  if (options.generation && secrets?.generation !== options.generation) {
    throw new StaleCredentialsError();
  }
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

  const key = `${connectionId}:${secrets.generation}`;
  let pending = inflight.get(key);
  if (!pending) {
    const budgetEnd = Date.now() + REFRESH_BUDGET_MS;
    pending = awaitWithDeadline(
      refresh(deps, connectionId, secrets, budgetEnd),
      budgetEnd,
    ).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    // Handled even when every caller stopped waiting.
    pending.catch(() => undefined);
    inflight.set(key, pending);
  }
  return awaitWithDeadline(pending, options.deadline);
}

/**
 * Waits for a shared operation, at most until `deadline` (epoch ms). Only
 * this caller stops waiting: the operation itself goes on for the others.
 */
export function awaitWithDeadline<T>(
  shared: Promise<T>,
  deadline: number | undefined,
): Promise<T> {
  if (deadline === undefined) return shared;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(deadlineExceeded());
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    shared,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(deadlineExceeded()), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs a provider call with a valid token, refreshing once after a 401. */
export async function withAccessToken<T>(
  deps: CalendarDeps,
  connectionId: string,
  run: (accessToken: string) => Promise<T>,
  options: TokenOptions = {},
): Promise<T> {
  try {
    return await run(await getAccessToken(deps, connectionId, options));
  } catch (error) {
    if (
      error instanceof CalendarProviderError &&
      error.kind === "unauthorized"
    ) {
      return run(
        await getAccessToken(deps, connectionId, {
          ...options,
          forceRefresh: true,
        }),
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
  // Reconnected or disconnected meanwhile: the professional's view changed.
  if (error instanceof StaleCredentialsError) {
    return new AppException("conflict", { cause: error });
  }
  return error;
}
