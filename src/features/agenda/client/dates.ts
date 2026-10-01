import { addDaysToLocalDate, weekdayOfLocalDate } from "@/lib/time/local-date";

// Local calendar helpers for the agenda UI. Every value is a wall-clock
// string in the business time zone, exactly as the server sends it
// (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`): the UI never converts instants itself
// (today and placement come from PostgreSQL, see ./zone.ts).

export type AgendaView = "week" | "day";

export type VisibleRange = {
  startDate: string;
  endDate: string;
  days: string[];
};

/** Monday of the week containing `date` (weeks start on Monday in France). */
export function startOfWeek(date: string) {
  const weekday = weekdayOfLocalDate(date); // 0 = Sunday
  return addDaysToLocalDate(date, -((weekday + 6) % 7));
}

/** The days one view shows around `anchor`: 7 for a week, 1 for a day. */
export function visibleRange(view: AgendaView, anchor: string): VisibleRange {
  const startDate = view === "week" ? startOfWeek(anchor) : anchor;
  const count = view === "week" ? 7 : 1;
  const days = Array.from({ length: count }, (_, index) =>
    addDaysToLocalDate(startDate, index),
  );
  return { startDate, endDate: days[days.length - 1]!, days };
}

export function shiftAnchor(
  view: AgendaView,
  anchor: string,
  direction: -1 | 1,
) {
  return addDaysToLocalDate(anchor, direction * (view === "week" ? 7 : 1));
}

export const dateOf = (local: string) => local.slice(0, 10);
export const timeOf = (local: string) => local.slice(11, 16);

/** Minutes since local midnight of a `…THH:MM` value. */
export function minutesOf(local: string) {
  const time = timeOf(local);
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function timeFromMinutes(minutes: number) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, minutes));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

// A local date formatted as itself: noon UTC of that calendar day, printed
// in UTC, can never shift to another day whatever the viewer's zone.
function calendarDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, 12));
}

const formatter = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", ...options });

const weekdayShort = formatter({ weekday: "short" });
const weekdayLong = formatter({ weekday: "long" });
const dayMonthShort = formatter({ day: "numeric", month: "short" });
const dayMonthLong = formatter({ day: "numeric", month: "long" });
const fullDate = formatter({
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export const formatWeekdayShort = (date: string) =>
  weekdayShort.format(calendarDate(date)).replace(".", "");
export const formatWeekdayLong = (date: string) =>
  weekdayLong.format(calendarDate(date));
export const formatDayMonth = (date: string) =>
  dayMonthShort.format(calendarDate(date));
export const formatFullDate = (date: string) =>
  fullDate.format(calendarDate(date));
export const dayNumber = (date: string) => Number(date.slice(8, 10));

/** Header label of the visible period. */
export function periodLabel(view: AgendaView, range: VisibleRange) {
  if (view === "day") {
    const label = `${weekdayLong.format(calendarDate(range.startDate))} ${dayMonthLong.format(calendarDate(range.startDate))}`;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  const year = range.endDate.slice(0, 4);
  return `${formatDayMonth(range.startDate)} – ${formatDayMonth(range.endDate)} ${year}`;
}

/** "1 h 15", "45 min". */
export function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
}
