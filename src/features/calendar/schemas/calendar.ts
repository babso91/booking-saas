import { z } from "zod";

// Inputs of the calendar Server Actions. No business, connection or user id
// is ever accepted: the tenant comes from the session.

export const updateBlockingCalendarsSchema = z.object({
  /** The complete set of blocking calendars after the change (max 50). */
  calendarIds: z.array(z.uuid()).max(50),
});

export const listConnectedCalendarsSchema = z
  .object({
    /** Re-read the list from the provider first. */
    refresh: z.boolean().default(false),
  })
  .default({ refresh: false });

export const listCalendarConflictsSchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine(
    (range) =>
      Date.parse(range.to) > Date.parse(range.from) &&
      Date.parse(range.to) - Date.parse(range.from) <= 400 * 86_400_000,
    { message: "Période invalide (400 jours au plus).", path: ["to"] },
  );
