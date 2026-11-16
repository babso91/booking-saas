import "server-only";

// The customer session cookies (docs/CLIENT_HUB_CONTRACT.md, "Sessions in
// the browser"). Every session has its own cookie, named after the
// session's id: `__Host-client_hub_s_<session id>=<token>`. The token is an
// opaque 256-bit value issued by public.client_hub_sign_in; PostgreSQL keeps
// only its SHA-256. The cookies are HttpOnly (never readable by scripts),
// SameSite=Lax (not sent with cross-site POST/DELETE), and carry the
// `__Host-` prefix: the browser accepts such a cookie only with Secure,
// Path=/ and no Domain, set by this very host. A sibling subdomain can plant
// `Domain=` cookies for this host, but never one with that prefix: only
// cookies this host set are read (no forced sign-in into someone else's
// session, no lockout by planted cookies). Cookies without the prefix,
// whatever they look like, are ignored and never counted. They are
// unrelated to the professionals' Supabase session (no page or route of the
// professionals reads them, although Path=/ sends them along).
//
// Why one cookie per session: a browser applies a response's Set-Cookie
// when it arrives, and the last one wins. With one name shared by every tab,
// a late answer erased or replaced a session opened meanwhile. Now a
// response only ever ADDS the cookie of the session it created, or DELETES
// cookies of sessions that are over: whatever order those arrive in, the
// browser ends up with the same cookies. Which presented session a request
// acts as is decided by PostgreSQL (public.client_hub_resolve_session).

export const SESSION_COOKIE_PREFIX = "__Host-client_hub_s_";
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
 * exactly `__Host-client_hub_s_<lowercase uuid>` (case included) is not one
 * of ours: it is ignored, never counted and never deleted. A
 * well-formed name with a malformed value, or a name present twice (which
 * the prefix makes impossible from another host), is kept as is: each value is
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

// What the __Host- prefix requires: Secure (also in local development:
// browsers accept Secure cookies on http://localhost), Path=/, no Domain.
function attributes(maxAge: number) {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${maxAge}`,
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
