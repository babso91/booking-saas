/**
 * Session cookies and Supabase Auth outages.
 *
 * auth-js removes the stored session when a refresh fails with an error it
 * does not retry, AuthUnknownError included: an answer it cannot read (an
 * HTML 403 or 418 from a proxy or a firewall…). That is an outage, not a
 * refusal: her refresh token may be perfectly valid, and deleting it signs
 * her out for good once Auth is back.
 *
 * So the server client observes its own exchanges with Auth, and a
 * deletion is applied only if the last one was an answer Auth really gave:
 *   readable   a 2xx, or a 4xx (not 429) whose body is JSON: Auth answered
 *              (a refused refresh token, a revoked session…): its
 *              deletions are applied;
 *   unreachable no answer, a 5xx, a 429, or a body that is not JSON: its
 *              deletions are dropped, her cookies stay as they are.
 * The same rule as authFailureOf (src/lib/supabase/auth-errors.ts), from
 * the HTTP exchange, which is all the cookie writer sees. Writes that set a
 * cookie (a refreshed session) are never dropped.
 *
 * Signing out on purpose is not decided by this: see
 * createServerSupabaseClient's "sign_out" purpose.
 */

export type CookieWrite = {
  name: string;
  value: string;
  options?: { maxAge?: number } & Record<string, unknown>;
};

/** A write that removes a cookie (empty value, or expired). */
export function deletesCookie({ value, options }: CookieWrite) {
  return value === "" || options?.maxAge === 0;
}

/**
 * A cookie auth-js stores the session in, for this Supabase URL: the
 * default storage key of supabase-js, its chunks, and the PKCE verifier.
 */
export function isSessionCookie(name: string, supabaseUrl: string) {
  const key = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  return (
    name === key ||
    name.startsWith(`${key}.`) ||
    name === `${key}-code-verifier` ||
    name.startsWith(`${key}-code-verifier.`)
  );
}

function isAuthRequest(input: RequestInfo | URL) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  try {
    return new URL(url).pathname.startsWith("/auth/v1/");
  } catch {
    return false;
  }
}

/** Whether Auth gave this answer (see above). Reads a clone only. */
async function answeredByAuth(response: Response) {
  if (response.ok) return true;
  if (response.status >= 500 || response.status === 429) return false;
  try {
    await response.clone().json();
    return true;
  } catch {
    return false;
  }
}

/**
 * A fetch for the Supabase client that remembers whether Auth answered its
 * last request, and the filter its cookie writes go through.
 */
export function authOutageGuard() {
  let unreachable = false;

  const fetchObserved: typeof fetch = async (input, init) => {
    if (!isAuthRequest(input)) return fetch(input, init);
    try {
      const response = await fetch(input, init);
      unreachable = !(await answeredByAuth(response));
      return response;
    } catch (error) {
      unreachable = true;
      throw error;
    }
  };

  return {
    fetch: fetchObserved,
    /** The writes to apply: deletions are dropped while Auth is unreachable. */
    filter<W extends CookieWrite>(writes: W[]): W[] {
      return unreachable
        ? writes.filter((write) => !deletesCookie(write))
        : writes;
    },
  };
}
