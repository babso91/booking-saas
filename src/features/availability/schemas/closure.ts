import { z } from "zod";

import {
  localDateSchema,
  localDateTimeSchema,
} from "@/features/availability/schemas/availability";

// An unexpected closure over booked dates (Higani point 101). PostgreSQL
// (20261122190000_unexpected_closure.sql) checks everything again.

/** A link in her words (same rule as private.closure_message_has_link). */
export const MESSAGE_LINK =
  /(https?:|www\.|[\p{L}\p{N}-]\.(com|fr|net|org|eu|io|co|me|ly|be|ch|info|biz|xyz|app|link|site|shop|online|club|gl|gg|to)([^\p{L}\p{N}]|$))/iu;

export const closurePreviewSchema = z.object({
  businessId: z.uuid(),
  startDate: localDateSchema,
  endDate: localDateSchema,
});

export const closureDecisionSchema = z.object({
  appointmentId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  /** New local start `YYYY-MM-DDTHH:MM`, or null to cancel. */
  moveTo: localDateTimeSchema.nullable(),
  /** In the repeated autumn hour: which of the two. */
  occurrence: z.enum(["first", "second"]).optional(),
});

export const closureCommitSchema = closurePreviewSchema.extend({
  requestId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
  message: z
    .string()
    .trim()
    .max(500)
    .refine((value) => !MESSAGE_LINK.test(value), "Sans lien, s’il te plaît.")
    .optional(),
  decisions: z.array(closureDecisionSchema).max(100),
});

export type ClosureDecision = z.output<typeof closureDecisionSchema>;
export type ClosureCommitInput = z.output<typeof closureCommitSchema>;
