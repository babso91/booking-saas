/** Path of the Supabase Auth callback route (src/app/auth/callback). */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/**
 * Absolute callback URL sent to Supabase Auth as `emailRedirectTo`, built
 * from the canonical app origin (NEXT_PUBLIC_APP_URL). It must be listed in
 * the Auth redirect allow-list and served on the same host as the page that
 * started the flow, where the PKCE verifier cookie lives.
 */
export function authCallbackUrl(appUrl: string, next?: AllowedNext) {
  const url = new URL(AUTH_CALLBACK_PATH, new URL(appUrl).origin);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

const ALLOWED_NEXT = new Set([
  "/app",
  "/onboarding",
  "/login",
  "/invitation",
] as const);
type AllowedNext = typeof ALLOWED_NEXT extends Set<infer T> ? T : never;

/**
 * `next` target of the auth callback. Only a known internal path is accepted
 * (no open redirect); anything else falls back to "/app", whose guard sends
 * the user to the right place.
 */
export function safeNextPath(value: string | null) {
  return value && ALLOWED_NEXT.has(value as AllowedNext) ? value : "/app";
}
