import { z } from "zod";

import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { optionChoiceIdsSchema } from "@/features/catalog/schemas";

// Inputs of offers and quotes (docs/OFFER_QUOTE_CONTRACT.md). The database
// checks everything again; the price is always the server's.

export const QUOTE_REF_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export const offerQuoteSchema = z.object({
  slug: businessSlugSchema,
  serviceId: z.uuid(),
  optionChoiceIds: optionChoiceIdsSchema.default([]),
  startsAt: z.iso.datetime({ offset: true }),
  coupon: z.string().trim().max(32).optional(),
});

export const promotionInputSchema = z
  .object({
    kind: z.enum(["offer", "code"]),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,32}$/)
      .optional(),
    label: z.string().trim().min(1).max(80),
    percentOff: z.number().int().min(1).max(100).optional(),
    amountOffCents: z.number().int().min(1).max(1_000_000).optional(),
    minBasisCents: z.number().int().min(0).optional(),
    serviceIds: z.array(z.uuid()).min(1).max(200).nullable().optional(),
    validFrom: z.iso.datetime({ offset: true }).nullable().optional(),
    validUntil: z.iso.datetime({ offset: true }).nullable().optional(),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .max(7)
      .nullable()
      .optional(),
    localStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
    localEndMinute: z.number().int().min(1).max(1440).nullable().optional(),
    minNoticeMinutes: z.number().int().min(0).max(525_600).optional(),
    quotaLimit: z.number().int().min(1).nullable().optional(),
  })
  .refine(
    (p) => (p.percentOff === undefined) !== (p.amountOffCents === undefined),
    {
      path: ["percentOff"],
      message: "Un pourcentage ou un montant, pas les deux.",
    },
  )
  .refine((p) => (p.kind === "code") === (p.code !== undefined), {
    path: ["code"],
    message:
      "Un code est obligatoire pour une promotion à code, et seulement pour elle.",
  });

export const promotionStateSchema = z.object({
  promotionId: z.uuid(),
  state: z.enum(["active", "paused"]),
  expectedVersion: z.number().int().min(1),
});

export type OfferQuoteInput = z.output<typeof offerQuoteSchema>;
export type PromotionInput = z.output<typeof promotionInputSchema>;
