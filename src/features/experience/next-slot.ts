import type { NextSlotDto, SlotDto } from "@/features/availability/data/slots";
import {
  addDays,
  wallDate,
  wallTime,
} from "@/features/public-booking/client/business-time";

// Her next bookable slot, as her site shows it (Higani point 2): read once
// with the page (get_public_next_slots, the slots' own engine), shown as a
// hint. Booking reads the slots again: nothing is booked from this.

/** Her next slot by service; services without one are left out. */
export type NextSlots = Record<string, SlotDto>;

export const nextSlotsOf = (rows: NextSlotDto[] | null | undefined) =>
  Object.fromEntries(
    (rows ?? []).flatMap((row) =>
      row.slot ? [[row.serviceId, row.slot]] : [],
    ),
  ) as NextSlots;

/** The earliest of them: her next availability, whatever the service. */
export function earliestOf(next: NextSlots): SlotDto | null {
  let first: SlotDto | null = null;
  for (const slot of Object.values(next))
    if (!first || slot.startsAt < first.startsAt) first = slot;
  return first;
}

const shortDay = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/**
 * « Aujourd'hui à 15:30 », « Demain à 10:00 », « mar. 24 nov. à 10:00 »:
 * her wall clock, against her own today (never the visitor's).
 */
export function nextLabel(localStartsAt: string, today: string): string {
  const day = wallDate(localStartsAt);
  const at = wallTime(localStartsAt);
  if (day === today) return `Aujourd’hui à ${at}`;
  if (day === addDays(today, 1)) return `Demain à ${at}`;
  return `${shortDay.format(new Date(`${day}T12:00:00Z`))} à ${at}`;
}
