import "server-only";

import { sessionTokenOf } from "@/features/client-hub/data/session";
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

// Skeleton of the authenticated Client Hub routes: the session token comes
// from the cookie only (never from a parameter), PostgreSQL authenticates it
// and authorizes every read. An unknown, expired or revoked session answers
// 401 client_hub_unauthenticated, WITHOUT touching the cookie: a Set-Cookie
// deletion names the cookie, not its value, so a slow refused read of an
// older session would erase a newer session signed in meanwhile in the same
// browser. A dead cookie is harmless (every route refuses it); only an
// explicit sign-out (DELETE /api/client-hub/session) removes it.
export async function withClientHubSession<T>(
  request: Request,
  handler: (admin: AppSupabaseClient, token: string) => Promise<T>,
): Promise<Response> {
  try {
    const token = sessionTokenOf(request);
    if (!token) throw new AppException("client_hub_unauthenticated");
    return jsonOk(
      await handler(createAdminSupabaseClient() as AppSupabaseClient, token),
    );
  } catch (error) {
    return jsonError(error);
  }
}
