import {
  dateOf,
  formatDayMonth,
  formatFullDate,
  formatWeekdayShort,
  timeOf,
} from "@/features/agenda/client/dates";
import { timeWithOccurrence } from "@/features/agenda/client/occurrence";
import type { BusinessInstantDto } from "@/features/crm/types";

// Dates of the CRM screens. Every value comes from `local` (the wall clock
// PostgreSQL computed in the business time zone) and `occurrence`; nothing
// here converts an instant with the browser's time zone, and nothing works
// out "today" or "tomorrow" on the device.

const monthYear = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});
const dayMonthYearFormat = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const monthShortFormat = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "UTC",
  month: "short",
});
const weekdayAbbreviation = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "UTC",
  weekday: "short",
});

// A local date printed as itself: noon UTC of that day, formatted in UTC.
function calendarDay(local: string) {
  const [year, month, day] = dateOf(local).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, 12));
}

/** "2 octobre 2025" */
export const dayMonthYear = (instant: BusinessInstantDto) =>
  dayMonthYearFormat.format(calendarDay(instant.local));

/** "ven." */
export const weekdayShort = (instant: BusinessInstantDto) =>
  formatWeekdayShort(dateOf(instant.local));

/** "oct." */
export const monthShort = (instant: BusinessInstantDto) =>
  monthShortFormat.format(calendarDay(instant.local));

/** "2 oct." */
export const shortDate = (instant: BusinessInstantDto) =>
  formatDayMonth(dateOf(instant.local));

/** "2 oct. 2025" when the year matters (another year than `reference`). */
export function dateWithYear(
  instant: BusinessInstantDto,
  referenceYear: string,
) {
  const date = dateOf(instant.local);
  const short = formatDayMonth(date);
  return date.slice(0, 4) === referenceYear
    ? short
    : `${short} ${date.slice(0, 4)}`;
}

/** "jeudi 2 octobre 2025" */
export const longDate = (instant: BusinessInstantDto) =>
  formatFullDate(dateOf(instant.local));

/** "mars 2025" */
export function monthAndYear(instant: BusinessInstantDto) {
  const [year, month] = dateOf(instant.local).split("-").map(Number);
  return monthYear.format(new Date(Date.UTC(year!, month! - 1, 15, 12)));
}

/** "14:30", or "02:30 (heure d’hiver)" in the repeated autumn hour. */
export const timeLabel = (instant: BusinessInstantDto) =>
  timeWithOccurrence(
    timeOf(instant.local),
    instant.occurrence,
    dateOf(instant.local),
    null,
  );

/** "ven. 24 oct. · 14:30" */
export const dayAndTime = (instant: BusinessInstantDto) =>
  `${weekdayAbbreviation.format(calendarDay(instant.local))} ${shortDate(instant)} · ${timeLabel(instant)}`;

/** Initials for the monogram: "EL", or "E" without a last name. */
export function initials(firstName: string, lastName: string | null) {
  const letter = (value: string | null) =>
    value?.trim().charAt(0).toLocaleUpperCase("fr-FR") ?? "";
  return `${letter(firstName)}${letter(lastName)}` || "?";
}

/** The agenda day of an instant (the agenda opens on that day). */
export const agendaDayHref = (instant: BusinessInstantDto) =>
  `/app?date=${dateOf(instant.local)}` as const;
