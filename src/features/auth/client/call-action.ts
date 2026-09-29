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
    return {
      ok: false,
      error: { code: (await sessionExpired()) ? "unauthenticated" : "network" },
    };
  }
}

/**
 * Actions post to the current page. On a private page (/app, /onboarding)
 * the proxy redirects that request to /login once the session is gone, so
 * the call fails in transport instead of answering `unauthenticated`. Asking
 * the server whether the page still answers without a redirect tells an
 * expired session apart from a network problem.
 */
async function sessionExpired(): Promise<boolean> {
  if (typeof window === "undefined" || typeof fetch !== "function")
    return false;
  try {
    const response = await fetch(window.location.pathname, {
      method: "HEAD",
      redirect: "manual",
      cache: "no-store",
      credentials: "same-origin",
    });
    return (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    );
  } catch {
    return false;
  }
}
