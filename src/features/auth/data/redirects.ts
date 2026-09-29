const ALLOWED_NEXT = new Set(["/app", "/onboarding", "/login"]);

/**
 * `next` target of the auth callback. Only a known internal path is accepted
 * (no open redirect); anything else falls back to "/app", whose guard sends
 * the user to the right place.
 */
export function safeNextPath(value: string | null) {
  return value && ALLOWED_NEXT.has(value) ? value : "/app";
}
