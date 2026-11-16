import { z } from "zod";

// Inputs of her plan and billing (docs/PLATFORM_BILLING_CONTRACT.md).

const revision = z.number().int().min(1);

export const quoteChangeSchema = z.object({
  targetPlan: z.enum(["core", "signature"]),
  targetCadence: z.enum(["monthly", "yearly"]),
  expectedSubscriptionRevision: revision,
  promoCode: z.string().trim().max(40).optional(),
});

export const confirmChangeSchema = z.object({
  quoteId: z.string().regex(/^q_[A-Za-z0-9_-]{16}$/),
  expectedRevision: revision,
  operationId: z.uuid(),
});

export const cancelScheduledSchema = z.object({
  commandId: z.uuid(),
  operationId: z.uuid(),
});

export const cancellationSchema = z.object({
  expectedRevision: revision,
  operationId: z.uuid(),
});

/** A billing event as the provider adapter normalises it (no provider format). */
export const billingEventSchema = z.object({
  eventId: z.string().min(1).max(200),
  kind: z.enum([
    "payment_succeeded",
    "payment_failed",
    "renewal_succeeded",
    "renewal_failed",
  ]),
  sourceVersion: z.number().int().min(1),
  commandId: z.uuid().optional(),
  businessId: z.uuid().optional(),
  amountMinor: z.number().int().min(0).optional(),
  graceDays: z.number().int().min(0).max(30).optional(),
});
