import type { RequestKey } from "@/features/agenda/client/request-id";

import type { BookingCommand } from "./api";

// The booking request in flight or unconfirmed, for one business page and
// this browser tab (session storage). Kept from the moment it is sent until
// the backend's answer is read, so that an answer lost on the way (network,
// page left, back button, reload) is offered back and resent EXACTLY: same
// body, same request id, so the backend answers the booking it made instead
// of booking twice. Cleared once answered, or when the customer abandons it.
//
// It holds what the customer typed for this booking (name, email, phone),
// only in this tab, and only until it is resolved.

export type PendingBooking = {
  command: BookingCommand;
  key: RequestKey;
  /**
   * The slot's wall clock (`YYYY-MM-DDTHH:MM`, business time zone), as the
   * availability gave it: shown as is, never derived from `startsAt`.
   */
  localStartsAt: string;
};

const keyFor = (slug: string) => `public-booking:${slug}`;

/** Fallback when session storage is unavailable: this page load only. */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** For useSyncExternalStore: told whenever a pending booking changes. */
export function subscribePendingBooking(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The raw stored value (a stable string snapshot for rendering). */
export function pendingBookingSnapshot(slug: string): string | null {
  const key = keyFor(slug);
  try {
    return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function parsePendingBooking(
  slug: string,
  raw: string | null,
): PendingBooking | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingBooking> | null;
    const command = value?.command;
    const key = value?.key;
    const localStartsAt = value?.localStartsAt;
    // Never replayed under another business page.
    return command?.slug === slug &&
      typeof command.serviceId === "string" &&
      typeof command.startsAt === "string" &&
      typeof command.firstName === "string" &&
      typeof command.email === "string" &&
      typeof key?.id === "string" &&
      typeof key.fingerprint === "string" &&
      typeof localStartsAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localStartsAt)
      ? { command, key, localStartsAt }
      : null;
  } catch {
    return null;
  }
}

export function readPendingBooking(slug: string): PendingBooking | null {
  return parsePendingBooking(slug, pendingBookingSnapshot(slug));
}

export function writePendingBooking(slug: string, value: PendingBooking) {
  const key = keyFor(slug);
  const raw = JSON.stringify(value);
  try {
    window.sessionStorage.setItem(key, raw);
    memory.delete(key);
  } catch {
    memory.set(key, raw);
  }
  emit();
}

export function clearPendingBooking(slug: string) {
  const key = keyFor(slug);
  memory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable.
  }
  emit();
}
