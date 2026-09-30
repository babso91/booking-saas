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
 * asks the server for the current page, follows redirects, and concludes,
 * in this order:
 * 1. 5xx → `internal`, wherever it ended (a failing /login page proves
 *    nothing about the session);
 * 2. redirected to /login and answered successfully → the session is gone
 *    (`unauthenticated`);
 * 3. anything else — redirected elsewhere (e.g. /onboarding → /app after a
 *    completed onboarding whose response was lost), still on the page, an
 *    unexpected status — says nothing about the session: `network`, the
 *    caller retries; no answer, timeout or abort → `network` too.
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
    if (response.status >= 500) return "internal";
    const landedOn = new URL(response.url, window.location.href).pathname;
    if (
      response.ok &&
      response.redirected &&
      landedOn.replace(/\/+$/, "") === "/login"
    ) {
      return "unauthenticated";
    }
    return "network";
  } catch {
    return "network";
  } finally {
    clearTimeout(timer);
  }
}
