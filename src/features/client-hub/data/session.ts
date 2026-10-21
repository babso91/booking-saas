import "server-only";

// The customer session cookie. Its value is an opaque 256-bit token issued
// by public.client_hub_verify_code; PostgreSQL keeps only its SHA-256. It is
// HttpOnly (never readable by scripts), SameSite=Lax (not sent with
// cross-site POST/DELETE: the state-changing routes cannot be forged from
// another site), Secure outside local development, and scoped to the
// Client Hub API. It is unrelated to the professionals' Supabase session.

export const CLIENT_HUB_COOKIE = "client_hub_session";
const PATH = "/api/client-hub";
const TOKEN = /^[0-9a-f]{64}$/;

/**
 * The session token the request carries, if well-formed and unique: two
 * cookies of this name (one planted by a sibling subdomain, say) are
 * refused rather than guessed between.
 */
export function sessionTokenOf(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === CLIENT_HUB_COOKIE) {
      values.push(part.slice(index + 1).trim());
    }
  }
  return values.length === 1 && TOKEN.test(values[0]!) ? values[0]! : null;
}

function attributes(maxAge: number) {
  return [
    `Path=${PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

/** Set-Cookie for a new session, expiring with it. */
export function sessionCookie(token: string, expiresAt: string) {
  const maxAge = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
  return `${CLIENT_HUB_COOKIE}=${token}; ${attributes(maxAge)}`;
}

/** Set-Cookie that removes the session cookie. */
export function clearedSessionCookie() {
  return `${CLIENT_HUB_COOKIE}=; ${attributes(0)}`;
}
