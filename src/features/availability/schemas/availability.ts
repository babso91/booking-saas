import { z } from "zod";

import { businessSlugSchema } from "@/features/businesses/schemas/slug";

/** Local wall-clock time `HH:MM`; `24:00` closes a range at midnight. */
export const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Heure invalide (HH:MM).");

/** Local calendar date `YYYY-MM-DD` (a real date, not just the right shape). */
export const localDateSchema = z.iso.date("Date invalide (AAAA-MM-JJ).");

/** Local wall-clock date-time `YYYY-MM-DDTHH:MM` in the business time zone. */
export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Date et heure invalides.")
  .refine(
    (value) =>
      localDateSchema.safeParse(value.slice(0, 10)).success &&
      localTimeSchema.safeParse(value.slice(11)).success &&
      value.slice(11) !== "24:00",
    "Date et heure invalides.",
  );

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
};

// 0 = Sunday … 6 = Saturday, as stored in business_hours.weekday.
export const weekdaySchema = z.number().int().min(0).max(6);

export const businessHourSchema = z
  .object({
    weekday: weekdaySchema,
    startsAt: localTimeSchema,
    endsAt: localTimeSchema,
  })
  .refine((range) => toMinutes(range.startsAt) < toMinutes(range.endsAt), {
    message: "La fin doit être après le début.",
    path: ["endsAt"],
  });

/** Complete weekly schedule. A weekday without range is a closed day. */
export const replaceBusinessHoursSchema = z
  .object({ hours: z.array(businessHourSchema).max(7 * 12) })
  .superRefine(({ hours }, ctx) => {
    const byDay = new Map<number, { start: number; end: number }[]>();

    hours.forEach((range, index) => {
      const start = toMinutes(range.startsAt);
      const end = toMinutes(range.endsAt);
      const sameDay = byDay.get(range.weekday) ?? [];

      if (sameDay.some((other) => start < other.end && other.start < end)) {
        ctx.addIssue({
          code: "custom",
          message: "Deux plages du même jour se chevauchent.",
          path: ["hours", index],
        });
      }

      sameDay.push({ start, end });
      byDay.set(range.weekday, sameDay);
    });
  });

export const updateBookingSettingsSchema = z
  .object({
    slotIntervalMinutes: z.number().int().min(5).max(120).optional(),
    bufferMinutes: z.number().int().min(0).max(240).optional(),
    minimumBookingNoticeMinutes: z.number().int().min(0).max(10_080).optional(),
    maximumBookingAdvanceDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((changes) => Object.values(changes).some((v) => v !== undefined), {
    message: "Aucune modification fournie.",
  });

export const availabilityExceptionKindSchema = z.enum([
  "closed",
  "blocked",
  "open_override",
]);

const exceptionFields = z.object({
  kind: availabilityExceptionKindSchema,
  // Wall-clock times in the business time zone; converted to UTC server-side.
  startsAt: localDateTimeSchema,
  endsAt: localDateTimeSchema,
  reason: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => (value ? value : null)),
});

// Local date-times of equal width compare correctly as strings.
const endsAfterStart = <T extends { startsAt: string; endsAt: string }>(
  value: T,
) => value.startsAt < value.endsAt;

export const createAvailabilityExceptionSchema = exceptionFields.refine(
  endsAfterStart,
  { message: "La fin doit être après le début.", path: ["endsAt"] },
);

export const updateAvailabilityExceptionSchema = exceptionFields
  .extend({ exceptionId: z.uuid() })
  .refine(endsAfterStart, {
    message: "La fin doit être après le début.",
    path: ["endsAt"],
  });

export const deleteAvailabilityExceptionSchema = z.object({
  exceptionId: z.uuid(),
});

export const listAvailabilityExceptionsSchema = z
  .object({ from: z.iso.datetime({ offset: true }).optional() })
  .optional();

export const availabilityQuerySchema = z.object({
  slug: businessSlugSchema,
  serviceId: z.uuid(),
  date: localDateSchema,
});

export type ReplaceBusinessHoursInput = z.output<
  typeof replaceBusinessHoursSchema
>;
export type UpdateBookingSettingsInput = z.output<
  typeof updateBookingSettingsSchema
>;
export type AvailabilityExceptionInput = z.output<
  typeof createAvailabilityExceptionSchema
>;
export type AvailabilityQuery = z.output<typeof availabilityQuerySchema>;
