import { addDays } from "@/features/public-booking/client/business-time";

import type { WindowDto } from "./contract";

// The client's preferred moments, as the waitlist takes them: civil days of the
// business and a period of the day. Days are offered up to 14 ahead (and
// never beyond the business's own booking horizon); five windows at most.

export const MAX_DAYS_AHEAD = 14;
export const MAX_WINDOWS = 5;

export type Period = "morning" | "afternoon" | "evening" | "day";

export const periods: Record<
  Period,
  { label: string; hint: string; start: number; end: number }
> = {
  morning: { label: "Le matin", hint: "avant 12 h", start: 0, end: 720 },
  afternoon: {
    label: "L’après-midi",
    hint: "12 h – 18 h",
    start: 720,
    end: 1080,
  },
  evening: {
    label: "En fin de journée",
    hint: "après 18 h",
    start: 1080,
    end: 1440,
  },
  day: {
    label: "Toute la journée",
    hint: "à n’importe quelle heure",
    start: 0,
    end: 1440,
  },
};

/** The days she (the client) may choose: from today, as far as both limits allow. */
export function eligibleDays(today: string, horizonDays: number): string[] {
  const count = Math.max(0, Math.min(MAX_DAYS_AHEAD, horizonDays)) + 1;
  return Array.from({ length: count }, (_, index) => addDays(today, index));
}

/** Her days and period as windows, in day order (one per day). */
export function windowsOf(days: string[], period: Period): WindowDto[] {
  const { start, end } = periods[period];
  return [...days].sort().map((localDate) => ({
    localDate,
    startMinute: start,
    endMinute: end,
  }));
}

export type JoinErrors = Partial<
  Record<"days" | "firstName" | "email" | "consent", string>
>;

export function checkJoin(input: {
  anyTime: boolean;
  days: string[];
  firstName: string;
  email: string;
  consent: boolean;
}): JoinErrors {
  const errors: JoinErrors = {};
  if (!input.anyTime && input.days.length === 0)
    errors.days = "Choisissez au moins un jour, ou « Dès que possible ».";
  if (!input.anyTime && input.days.length > MAX_WINDOWS)
    errors.days = `${MAX_WINDOWS} jours au plus.`;
  if (!input.firstName.trim()) errors.firstName = "Votre prénom.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))
    errors.email = "Une adresse email valide.";
  if (!input.consent)
    errors.consent =
      "Nécessaire pour vous prévenir quand un créneau se libère.";
  return errors;
}
