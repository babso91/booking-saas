/**
 * Her appointment in her own calendar (Higani point 79): a calendar file
 * (Apple, Outlook and most apps) or Google Calendar's own form. Times are
 * the booking's UTC instants, written as UTC: no time zone is converted
 * here, every calendar shows them in her own.
 */
export type CalendarEvent = {
  /** Stable across downloads: adding it twice updates the same event. */
  id: string;
  title: string;
  /** UTC instants (ISO 8601), as the server answered. */
  startsAt: string;
  endsAt: string;
  location?: string | null;
  details?: string | null;
};

/** 2026-11-28T09:30:00.000Z → 20261128T093000Z */
const utc = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const escape = (text: string) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

/** RFC 5545: lines of 75 bytes at most, continued by a space. */
function fold(line: string) {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function calendarFile(event: CalendarEvent, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Higani//Rendez-vous//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@higani`,
    `DTSTAMP:${utc(now.toISOString())}`,
    `DTSTART:${utc(event.startsAt)}`,
    `DTEND:${utc(event.endsAt)}`,
    `SUMMARY:${escape(event.title)}`,
    ...(event.location ? [`LOCATION:${escape(event.location)}`] : []),
    ...(event.details ? [`DESCRIPTION:${escape(event.details)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function googleCalendarHref(event: CalendarEvent) {
  const query = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${utc(event.startsAt)}/${utc(event.endsAt)}`,
  });
  if (event.location) query.set("location", event.location);
  if (event.details) query.set("details", event.details);
  return `https://calendar.google.com/calendar/render?${query}`;
}
