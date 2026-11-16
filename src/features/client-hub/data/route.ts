import "server-only";

import { resolveSession } from "@/features/client-hub/data/client-hub";
import {
  ACCOUNT_HEADER,
  appendCleared,
  presentedSessions,
  sessionCookieName,
} from "@/features/client-hub/data/session";
import { getPublicEnv } from "@/lib/env/public";
import { AppException } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppSupabaseClient } from "@/lib/supabase/types";

/**
 * State-changing Client Hub requests (POST, DELETE) come from the app's own
 * pages only. A cross-site form can post a body that parses as JSON with
 * `Content-Type: text/plain` (no preflight), and the response's cookie would
 * be set: a login CSRF signing the visitor into someone else's hub. So: a
 * JSON content type is required for bodies, and the browser's
 * `Sec-Fetch-Site` and `Origin`, when present, must say same origin.
 */
export function assertSameOrigin(request: Request, body: boolean) {
  if (body) {
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json(\s*;|$)/i.test(type)) {
      throw new AppException("forbidden");
    }
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new AppException("forbidden");
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).origin) {
    throw new AppException("forbidden");
  }
}

// Skeleton of the authenticated Client Hub routes. The session comes from
// the cookies only (never from a parameter). PostgreSQL decides which of the
// presented sessions the request acts as (client_hub_resolve_session: the
// most recent live session of one account; live sessions of several
// accounts are all ended and none is chosen), then authenticates it again
// and authorizes every read. Every private answer names the account it was
// served for (X-Client-Hub-Account): the pages show nothing served for
// another identity than the one they confirmed.
//
// Cookies: an answer deletes the cookies the request presented that are now
// known to authenticate nothing (ended, expired, forged, or another account
// in a conflict), and only those: no response can erase a session opened
// after the request left, since that session has another cookie name. When
// the database could not answer, nothing is deleted. A refusal is 401
// client_hub_unauthenticated.
export async function withClientHubSession<T>(
  request: Request,
  handler: (admin: AppSupabaseClient, token: string) => Promise<T>,
): Promise<Response> {
  const presented = presentedSessions(request);
  // Names whose sessions are known to be over; null: nothing is known.
  let over: string[] | null = null;
  let account: string | null = null;
  let response: Response;
  try {
    if (presented.excessive || presented.sessions.length === 0) {
      over = presented.names;
      throw new AppException("client_hub_unauthenticated");
    }
    const admin = createAdminSupabaseClient() as AppSupabaseClient;
    const resolved = await resolveSession(admin, presented);
    if (resolved.status !== "ok") {
      over = presented.names;
      throw new AppException("client_hub_unauthenticated");
    }
    const kept = sessionCookieName(resolved.sessionId);
    over = presented.names.filter((name) => name !== kept);
    account = resolved.accountId;
    response = jsonOk(await handler(admin, resolved.token));
  } catch (error) {
    if (
      error instanceof AppException &&
      error.code === "client_hub_unauthenticated"
    ) {
      // Ended between the resolution and the read: every presented one is.
      if (over !== null) over = presented.names;
      account = null;
    }
    response = jsonError(error);
  }
  if (account) response.headers.set(ACCOUNT_HEADER, account);
  return over ? appendCleared(response, over) : response;
}
