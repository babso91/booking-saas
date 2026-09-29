import type { ActionResult, AppErrorCode } from "@/lib/errors";

/**
 * Error codes the auth/onboarding screens can render: every backend code
 * (docs/AUTH_ONBOARDING_CONTRACT.md) plus `network`, when the Server Action
 * request itself never completes (offline, server unreachable).
 */
export type UiErrorCode = AppErrorCode | "network";

export type UiError = {
  code: UiErrorCode;
  fieldErrors?: Record<string, string[]>;
};

export type UiResult<T> = { ok: true; data: T } | { ok: false; error: UiError };

/**
 * Calls a Server Action from a Client Component. Actions never throw by
 * contract, so a rejection can only be transport-level. The backend message
 * is dropped on purpose: screens render their own copy for each code.
 */
export async function callAction<T>(
  action: () => Promise<ActionResult<T>>,
): Promise<UiResult<T>> {
  try {
    const result = await action();

    if (result.ok) return result;

    return {
      ok: false,
      error: result.error.fieldErrors
        ? { code: result.error.code, fieldErrors: result.error.fieldErrors }
        : { code: result.error.code },
    };
  } catch {
    return { ok: false, error: { code: await classifyTransportFailure() } };
  }
}

/** Longest wait for the probe: the UI never hangs on it. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Why did a Server Action request fail in transport?
 *
 * Actions post to the current page. On a private page the proxy answers a
 * request without session with a redirect to /login, which the action call
 * cannot parse. The guards and the proxy send to /login for one state only,
 * `unauthenticated` (docs/AUTH_ONBOARDING_CONTRACT.md, Routage), so the probe
 * asks the server for the current page, follows redirects, and concludes:
 * - landed on /login → the session is gone (`unauthenticated`);
 * - redirected elsewhere (e.g. /onboarding → /app after a completed
 *   onboarding whose response was lost) → a legitimate new destination,
 *   the session is fine: reported as `network`, the caller retries;
 * - 5xx → `internal`; no answer or timeout → `network`.
 */
async function classifyTransportFailure(): Promise<
  "unauthenticated" | "internal" | "network"
> {
  if (typeof window === "undefined" || typeof fetch !== "function")
    return "network";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${window.location.pathname}${window.location.search}`,
      {
        method: "HEAD",
        redirect: "follow",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      },
    );
    if (
      response.redirected &&
      new URL(response.url, window.location.href).pathname === "/login"
    ) {
      return "unauthenticated";
    }
    return response.status >= 500 ? "internal" : "network";
  } catch {
    return "network";
  } finally {
    clearTimeout(timer);
  }
}
