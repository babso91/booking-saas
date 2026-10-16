import { addDaysToLocalDate } from "@/lib/time/local-date";

// Dates and times of the public booking, always in the BUSINESS time zone.
//
// - Bookable slots come from the backend with their wall clock
//   (`localStartsAt`, `YYYY-MM-DDTHH:MM`): displayed as is, never converted
//   with the browser's time zone database (PostgreSQL is the calendar
//   authority, docs/ARCHITECTURE.md §8).
// - Days are civil dates (`YYYY-MM-DD`): plain calendar arithmetic
//   (@/lib/time/local-date), no time zone involved.
// - One exception, navigational only: which civil day it is now at the
//   business, to start the list of days (the public routes do not say it).
//   It decides nothing: every day and slot is the backend's answer.

export { addDaysToLocalDate as addDays };

/** Today's civil date in `timezone` (where the day list starts). */
export function businessToday(timezone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const noonUtc = (date: string) => new Date(`${date}T12:00:00Z`);

const civil = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("fr-FR", { ...options, timeZone: "UTC" });

const weekdayShort = civil({ weekday: "short" });
const monthShort = civil({ month: "short" });
const longDay = civil({ weekday: "long", day: "numeric", month: "long" });
const longDayYear = civil({
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const trimDot = (value: string) => value.replace(/\.$/, "");

/** A civil date for a day picker: « lun. », « 19 », « oct. ». */
export function dayParts(date: string) {
  const at = noonUtc(date);
  return {
    weekday: trimDot(weekdayShort.format(at)),
    day: String(at.getUTCDate()),
    month: trimDot(monthShort.format(at)),
  };
}

/** « lundi 19 octobre » (with the year when asked). */
export function dayLabel(date: string, withYear = false): string {
  return (withYear ? longDayYear : longDay).format(noonUtc(date));
}

/** « 09:30 » from a wall clock `YYYY-MM-DDTHH:MM`. */
export const wallTime = (local: string) => local.slice(11, 16);

/** The civil date of a wall clock `YYYY-MM-DDTHH:MM`. */
export const wallDate = (local: string) => local.slice(0, 10);

/** « Europe/Paris » → « Paris » (readable city of an IANA zone). */
export function zoneCity(timezone: string): string {
  const city = timezone.split("/").at(-1) ?? timezone;
  return city.replace(/_/g, " ");
}

/** The browser's own zone, when it can be read (rendering only). */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
