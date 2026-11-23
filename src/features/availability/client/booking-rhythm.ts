// The rhythm of her online bookings (points 220, 221 and 222), in human
// terms. Values map 1:1 to `business_settings` and stay within its checks;
// a value stored outside the usual choices (set at signup, imported) is
// kept as a choice of its own, never silently replaced.

import {
  bufferOptions,
  noticeOptions,
  type Option,
} from "@/features/onboarding/settings";

/** "5 min", "1 h", "1 h 30", "2 jours". */
export function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} jour${days > 1 ? "s" : ""}`;
  }
  const hours = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
}

// slot_interval_minutes (5–120)
export const intervalOptions: Option<number>[] = [
  5, 10, 15, 20, 30, 45, 60, 90, 120,
].map((value) => ({
  value,
  label:
    value === 60 ? "Toutes les heures" : `Toutes les ${minutesLabel(value)}`,
}));

// minimum_booking_notice_minutes (0–10080)
export const rhythmNoticeOptions: Option<number>[] = [
  { value: 0, label: "Aucun : jusqu’à la dernière minute" },
  ...noticeOptions,
  { value: 10_080, label: "1 semaine" },
];

// buffer_minutes (0–240)
export const rhythmBufferOptions: Option<number>[] = [
  ...bufferOptions,
  { value: 45, label: "45 min" },
  { value: 60, label: "1 h" },
];

/** The choices, with the stored value among them even when unusual. */
export function choicesWith(options: Option<number>[], current: number) {
  return options.some((option) => option.value === current)
    ? options
    : [...options, { value: current, label: minutesLabel(current) }].sort(
        (a, b) => a.value - b.value,
      );
}

/**
 * "9 h 00, 9 h 15, 9 h 30…": her first slots when she opens at `opening`,
 * each time kept on one line (non-breaking spaces).
 */
export function slotExample(intervalMinutes: number, opening = 9 * 60) {
  return `${[0, 1, 2]
    .map((index) => {
      const at = opening + index * intervalMinutes;
      return `${Math.trunc(at / 60)}\u00a0h\u00a0${String(at % 60).padStart(2, "0")}`;
    })
    .join(", ")}…`;
}
