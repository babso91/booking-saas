import "server-only";

// The customer session cookies (docs/CLIENT_HUB_CONTRACT.md, "Sessions in
// the browser"). Every session has its own cookie, named after the
// session's id: `client_hub_s_<session id>=<token>`. The token is an opaque
// 256-bit value issued by public.client_hub_sign_in; PostgreSQL keeps only
// its SHA-256. The cookies are HttpOnly (never readable by scripts),
// SameSite=Lax (not sent with cross-site POST/DELETE), Secure outside local
// development, without Domain (this host only) and scoped to the Client Hub
// API. They are unrelated to the professionals' Supabase session.
//
// Why one cookie per session: a browser applies a response's Set-Cookie
// when it arrives, and the last one wins. With one name shared by every tab,
// a late answer erased or replaced a session opened meanwhile. Now a
// response only ever ADDS the cookie of the session it created, or DELETES
// cookies of sessions that are over: whatever order those arrive in, the
// browser ends up with the same cookies. Which presented session a request
// acts as is decided by PostgreSQL (public.client_hub_resolve_session).

export const SESSION_COOKIE_PREFIX = "client_hub_s_";
const PATH = "/api/client-hub";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAME = new RegExp(`^${SESSION_COOKIE_PREFIX}(${UUID})$`);
const TOKEN = /^[0-9a-f]{64}$/;

/** More presented session cookies than this: the browser's are all dropped. */
export const MAX_PRESENTED_SESSIONS = 16;

export type PresentedSessions = {
  /** Every well-formed session cookie name, once each. */
  names: string[];
  /** The (session id, token) pairs to examine, once each. */
  sessions: string[];
  tokens: string[];
  /**
   * More session cookies than MAX_PRESENTED_SESSIONS: none of them is used
   * or ended (fail closed); they are all deleted from the browser.
   */
  excessive: boolean;
};

/**
 * The session cookies the request carries. A cookie whose name is not
 * exactly `client_hub_s_<lowercase uuid>` is not one of ours and is ignored
 * (never deleted: it cannot be told apart from someone else's cookie). A
 * well-formed name with a malformed value, or a name present twice (one
 * planted by a sibling subdomain, say), is kept as is: each value is
 * examined on its own, and a value only counts if PostgreSQL finds it is the
 * token of the very session its name designates. Nothing is ever guessed.
 */
export function presentedSessions(request: Request): PresentedSessions {
  const names = new Set<string>();
  const pairs = new Map<string, [string, string]>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const session = NAME.exec(name)?.[1];
    if (!session) continue;
    names.add(name);
    const value = part.slice(index + 1).trim();
    if (TOKEN.test(value)) pairs.set(`${session}|${value}`, [session, value]);
  }
  const excessive =
    names.size > MAX_PRESENTED_SESSIONS || pairs.size > MAX_PRESENTED_SESSIONS;
  const kept = excessive ? [] : [...pairs.values()];
  return {
    names: [...names],
    sessions: kept.map(([session]) => session),
    tokens: kept.map(([, token]) => token),
    excessive,
  };
}

export const sessionCookieName = (sessionId: string) =>
  `${SESSION_COOKIE_PREFIX}${sessionId}`;

function attributes(maxAge: number) {
  return [
    `Path=${PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

/** Set-Cookie adding a new session's own cookie, expiring with it. */
export function sessionCookie(
  sessionId: string,
  token: string,
  expiresAt: string,
) {
  if (!NAME.test(sessionCookieName(sessionId)) || !TOKEN.test(token)) {
    throw new Error("Malformed session cookie");
  }
  const maxAge = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
  return `${sessionCookieName(sessionId)}=${token}; ${attributes(maxAge)}`;
}

/**
 * Set-Cookie deleting one session's cookie. Only for a session that is over
 * (or a cookie that authenticates nothing): no later response can bring
 * that name back to life, since only the sign-in that created a session
 * ever sets its cookie.
 */
export function clearedSessionCookie(name: string) {
  return `${name}=; ${attributes(0)}`;
}

/** Deletes `names` (cookies of sessions that are over) from the browser. */
export function appendCleared(response: Response, names: Iterable<string>) {
  for (const name of names) {
    response.headers.append("Set-Cookie", clearedSessionCookie(name));
  }
  return response;
}

/** The header that says which account a private answer was served for. */
export const ACCOUNT_HEADER = "X-Client-Hub-Account";
