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
    return { ok: false, error: { code: "network" } };
  }
}
