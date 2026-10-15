// Unsaved setup drafts (services, weekly hours) are kept for the browser
// session, never as a source of truth, and always under the identity they
// were typed for: the signed-in user AND the business, both taken from the
// server session (never from the client). A draft typed for one identity
// is never shown, stored or sent under another.
//
// Session storage only: values typed in a form (names, prices, hours) and
// the request id of an unconfirmed creation. No secret, no personal data
// about clients. Everything is removed at sign-out (clearSetupDrafts).

/** Who a draft belongs to, as resolved by the server session. */
export type DraftScope = { userId: string; businessId: string };

const PREFIX = "setup-draft:";

/** Identifies a scope: two scopes are the same identity iff equal. */
export const scopeId = (scope: DraftScope) =>
  `${scope.userId}:${scope.businessId}`;

/** The storage key of one draft, for one identity. */
export const draftKeyFor = (scope: DraftScope, ...path: string[]) =>
  [`${PREFIX}${scopeId(scope)}`, ...path].join(":");

/** Fallback when session storage is unavailable: this page load only. */
const memory = new Map<string, string>();

export function readDraftRaw(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writeDraftRaw(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}

export function removeDraft(key: string) {
  memory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable.
  }
}

/** Every setup draft, of every identity (sign-out). */
export function clearSetupDrafts() {
  for (const key of [...memory.keys()]) {
    if (key.startsWith(PREFIX)) memory.delete(key);
  }
  try {
    const storage = window.sessionStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Storage unavailable.
  }
}
