import type { Contact } from "./contact";

// Her booking in progress, for one business page and this browser tab
// (session storage), so that an accident never makes her start again
// (Higani point 67): a phone that reloads the tab while she checks her
// calendar, a booking sheet closed by mistake. Kept while she chooses,
// cleared once booked or when she starts over. Never sent anywhere: on
// return the slot is read again, and nothing is booked without her.
//
// Like the unconfirmed request (pending-booking.ts), it holds what she
// typed (name, email, phone), only in this tab.

export type DraftStep = "service" | "options" | "slot" | "contact" | "review";

export type BookingDraft = {
  serviceId: string;
  answers: Record<string, string | null>;
  date: string;
  /** The slot she had chosen (read again on return), if any. */
  startsAt: string | null;
  step: DraftStep;
  contact: Contact;
  savedAt: number;
};

/** A draft older than this is not offered back. */
export const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

const keyFor = (slug: string) => `public-booking-draft:${slug}`;
const STEPS: readonly DraftStep[] = [
  "service",
  "options",
  "slot",
  "contact",
  "review",
];
const text = (value: unknown): value is string => typeof value === "string";

export function readBookingDraft(
  slug: string,
  now = Date.now(),
): BookingDraft | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(keyFor(slug));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<BookingDraft> | null;
    const contact = value?.contact as Partial<Contact> | undefined;
    const answers = value?.answers;
    const valid =
      value &&
      text(value.serviceId) &&
      text(value.date) &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
      (value.startsAt === null || text(value.startsAt)) &&
      STEPS.includes(value.step as DraftStep) &&
      typeof value.savedAt === "number" &&
      now - value.savedAt < DRAFT_TTL_MS &&
      answers !== null &&
      typeof answers === "object" &&
      Object.values(answers).every((id) => id === null || text(id)) &&
      contact &&
      text(contact.firstName) &&
      text(contact.lastName) &&
      text(contact.email) &&
      text(contact.phone);
    return valid ? (value as BookingDraft) : null;
  } catch {
    return null;
  }
}

export function writeBookingDraft(slug: string, draft: BookingDraft) {
  try {
    window.sessionStorage.setItem(keyFor(slug), JSON.stringify(draft));
  } catch {
    // Storage unavailable: nothing kept beyond this page.
  }
}

export function clearBookingDraft(slug: string) {
  try {
    window.sessionStorage.removeItem(keyFor(slug));
  } catch {
    // Storage unavailable.
  }
}
