import { z } from "zod";

import {
  localDateSchema,
  localDateTimeSchema,
} from "@/features/availability/schemas/availability";
import { daysBetweenLocalDates } from "@/lib/time/zoned";

// Inputs of the professional agenda. Dates and times are wall-clock values in
// the business time zone; the server converts them (src/lib/time/zoned.ts).
// No business identifier is ever accepted: the tenant comes from the session.

/** Longest range one agenda read may cover (a 6-week month grid). */
export const MAX_AGENDA_RANGE_DAYS = 42;

/** Local wall-clock start time `HH:MM` (00:00–23:59). */
export const startTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Heure invalide (HH:MM).");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const versionSchema = z.number().int().min(1);

const areLocalDates = (...values: string[]) =>
  values.every((value) => localDateSchema.safeParse(value).success);

export const agendaRangeSchema = z
  .object({
    /** First local day shown, inclusive. */
    startDate: localDateSchema,
    /** Last local day shown, inclusive. */
    endDate: localDateSchema,
    includeCancelled: z.boolean().default(false),
  })
  .superRefine((range, ctx) => {
    // Zod 4 still runs refinements after a format issue on a field.
    if (!areLocalDates(range.startDate, range.endDate)) return;

    const days = daysBetweenLocalDates(range.startDate, range.endDate) + 1;

    if (days < 1) {
      ctx.addIssue({
        code: "custom",
        message: "La fin doit être après le début.",
        path: ["endDate"],
      });
    } else if (days > MAX_AGENDA_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        message: `Période limitée à ${MAX_AGENDA_RANGE_DAYS} jours.`,
        path: ["endDate"],
      });
    }
  });

export const appointmentIdSchema = z.object({ appointmentId: z.uuid() });

const newClientSchema = z.object({
  type: z.literal("new"),
  firstName: z.string().trim().min(1).max(120),
  lastName: optionalText(120),
  email: z
    .email("Email invalide.")
    .max(254)
    .nullish()
    .or(z.literal("").transform(() => null))
    .transform((value) => (value ? value.toLowerCase() : null)),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ().-]{6,30}$/, "Téléphone invalide.")
    .nullish()
    .or(z.literal("").transform(() => null))
    .transform((value) => value ?? null),
});

export const appointmentClientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), clientId: z.uuid() }),
  newClientSchema,
]);

export const createAppointmentSchema = z.object({
  date: localDateSchema,
  time: startTimeSchema,
  serviceId: z.uuid(),
  client: appointmentClientSchema,
  internalNotes: optionalText(2000),
  /** Generated once per form by the UI: a double submit creates one appointment. */
  requestId: z.uuid().optional(),
});

/** Full editable state of an appointment, as last loaded by the UI. */
export const updateAppointmentSchema = z.object({
  appointmentId: z.uuid(),
  expectedVersion: versionSchema,
  date: localDateSchema,
  time: startTimeSchema,
  serviceId: z.uuid(),
  clientId: z.uuid(),
  internalNotes: optionalText(2000),
});

export const appointmentStatusSchema = z.enum([
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
]);

export const setAppointmentStatusSchema = z.object({
  appointmentId: z.uuid(),
  expectedVersion: versionSchema,
  status: appointmentStatusSchema,
  cancellationReason: optionalText(500),
});

export const cancelAppointmentSchema = z.object({
  appointmentId: z.uuid(),
  expectedVersion: versionSchema,
  reason: optionalText(500),
});

// Blocks: a period (local date-times) or whole local days (inclusive).
const blockPeriodSchema = z
  .object({
    allDay: z.literal(false),
    startsAt: localDateTimeSchema,
    endsAt: localDateTimeSchema,
    reason: optionalText(500),
  })
  .refine((block) => block.startsAt < block.endsAt, {
    message: "La fin doit être après le début.",
    path: ["endsAt"],
  });

const blockDaysSchema = z
  .object({
    allDay: z.literal(true),
    startDate: localDateSchema,
    endDate: localDateSchema,
    reason: optionalText(500),
  })
  .refine(
    (block) =>
      !areLocalDates(block.startDate, block.endDate) ||
      (daysBetweenLocalDates(block.startDate, block.endDate) >= 0 &&
        daysBetweenLocalDates(block.startDate, block.endDate) < 366),
    { message: "Période invalide.", path: ["endDate"] },
  );

export const blockInputSchema = z.discriminatedUnion("allDay", [
  blockPeriodSchema,
  blockDaysSchema,
]);

export const createBlockSchema = blockInputSchema;

export const updateBlockSchema = z.object({
  blockId: z.uuid(),
  expectedVersion: versionSchema,
  block: blockInputSchema,
});

export const deleteBlockSchema = z.object({
  blockId: z.uuid(),
  expectedVersion: versionSchema,
});

export const searchClientsSchema = z.object({
  query: z.string().trim().min(2, "Au moins 2 caractères.").max(100),
});

export type AgendaRangeInput = z.output<typeof agendaRangeSchema>;
export type CreateAppointmentInput = z.output<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.output<typeof updateAppointmentSchema>;
export type SetAppointmentStatusInput = z.output<
  typeof setAppointmentStatusSchema
>;
export type AppointmentStatus = z.output<typeof appointmentStatusSchema>;
export type BlockInput = z.output<typeof blockInputSchema>;
