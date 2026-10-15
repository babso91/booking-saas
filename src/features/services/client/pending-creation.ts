import type { RequestKey } from "@/features/agenda/client/request-id";

import type { ServiceDraft } from "./service-form";

// The service creation in progress, for one business: what was typed, the
// request id of the command sent, and whether its answer was lost. Kept
// for the browser session so that closing the form, or leaving and coming
// back, never forgets an unconfirmed creation: its resend carries the same
// request id, and the backend answers the service it created instead of
// creating a second one. Never the source of truth (the list is).

export type PendingCreation = {
  draft: ServiceDraft;
  /** The request id of the last command sent (null: nothing sent yet). */
  key: RequestKey | null;
  /** The last answer was lost: the creation may already exist. */
  unconfirmed: boolean;
};

/** Fallback when session storage is unavailable: this page load only. */
const memory = new Map<string, string>();

export function readPendingCreation(
  storageKey: string,
): PendingCreation | null {
  try {
    const raw = pendingCreationSnapshot(storageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingCreation;
    return value && typeof value === "object" && value.draft ? value : null;
  } catch {
    return null;
  }
}

export function writePendingCreation(
  storageKey: string,
  value: PendingCreation,
) {
  const raw = JSON.stringify(value);
  try {
    window.sessionStorage.setItem(storageKey, raw);
    memory.delete(storageKey);
  } catch {
    // Storage unavailable: kept in memory for this page load only.
    memory.set(storageKey, raw);
  }
}

export function clearPendingCreation(storageKey: string) {
  memory.delete(storageKey);
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Storage unavailable.
  }
}

/** The raw stored value (a stable string snapshot for rendering). */
export function pendingCreationSnapshot(storageKey: string): string | null {
  try {
    return (
      window.sessionStorage.getItem(storageKey) ??
      memory.get(storageKey) ??
      null
    );
  } catch {
    return memory.get(storageKey) ?? null;
  }
}
