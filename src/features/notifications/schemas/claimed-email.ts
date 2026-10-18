import { z } from "zod";

// One email handed to the worker by public.email_outbox_claim: its claim
// and the data of its template, read by PostgreSQL from the current
// appointment and business at claim time. Wall-clock times (`local*`) come
// from PostgreSQL; the worker never converts an instant to a time zone.

const wallClock = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

export const emailTypeSchema = z.enum([
  "booking_confirmation",
  "appointment_reminder",
  "appointment_changed",
  "appointment_cancelled",
]);

export type EmailType = z.infer<typeof emailTypeSchema>;

export const claimedEmailSchema = z.object({
  id: z.uuid(),
  claimId: z.uuid(),
  businessId: z.uuid(),
  type: emailTypeSchema,
  attempt: z.number().int().min(1),
  recipient: z.string().min(3).max(254),
  /**
   * The message frozen at its first submission to the provider, when there
   * was one: sent again as is (same request, same idempotency key).
   */
  message: z
    .object({
      to: z.string(),
      from: z.string(),
      replyTo: z.string().optional(),
      subject: z.string(),
      text: z.string(),
      html: z.string(),
    })
    .nullable(),
  business: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    contactEmail: z.string().nullable(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    timezone: z.string().min(1),
  }),
  appointment: z.object({
    id: z.uuid(),
    /** The version the template data was read from (see email_outbox_prepare). */
    version: z.number().int().min(1),
    status: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    localStartsAt: wallClock,
    localEndsAt: wallClock,
    serviceName: z.string().min(1),
    durationMinutes: z.number().int().positive(),
    priceCents: z.number().int().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/),
    clientFirstName: z.string().nullable(),
  }),
});

export type ClaimedEmail = z.infer<typeof claimedEmailSchema>;

/** The claim of an item whose data could not be parsed (released as failed). */
export const claimIdentitySchema = z.object({
  id: z.uuid(),
  claimId: z.uuid(),
});
