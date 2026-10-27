import { addDaysToLocalDate } from "@/lib/time/local-date";

/**
 * `?date=YYYY-MM-DD` opens the agenda on that day (links from a customer
 * profile). Anything else is ignored and the agenda opens on today. Civil
 * date arithmetic only: no time zone involved.
 */
export function requestedDay(value: string | string[] | undefined) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  try {
    // A real calendar date: 2026-02-30 does not survive the round trip.
    return addDaysToLocalDate(value, 0) === value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `?rdv=<uuid>` opens that appointment's details once its day is read
 * (links from "Aujourd’hui"). Only a well-formed id is kept; whether it is
 * hers is decided by the agenda read itself (RLS), never by the link.
 */
export function requestedAppointment(value: string | string[] | undefined) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}
