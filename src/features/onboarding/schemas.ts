import { z } from "zod";

import { getSlugIssue, slugIssueMessages } from "./slug";
import { isValidTimezone } from "./settings";

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((value) => (value ? value : undefined));

export const identityStepSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, "Indique ton prénom.")
    .max(120, "120 caractères maximum."),
  lastName: z
    .string()
    .trim()
    .min(1, "Indique ton nom.")
    .max(120, "120 caractères maximum."),
  businessName: z
    .string()
    .trim()
    .min(1, "Indique le nom de ton activité.")
    .max(120, "120 caractères maximum."),
});

export const slugStepSchema = z.object({
  slug: z.string().superRefine((slug, ctx) => {
    const issue = getSlugIssue(slug);
    if (issue)
      ctx.addIssue({ code: "custom", message: slugIssueMessages[issue] });
  }),
});

export const preferencesStepSchema = z.object({
  timezone: z.string().refine(isValidTimezone, "Fuseau horaire inconnu."),
  minimumBookingNoticeMinutes: z.number().int().min(0).max(10080),
  maximumBookingAdvanceDays: z.number().int().min(1).max(365),
  bufferMinutes: z.number().int().min(0).max(240),
});

export const DESCRIPTION_MAX_LENGTH = 300;

export const detailsStepSchema = z.object({
  phone: optionalText(30, "Numéro trop long.").refine(
    (value) => !value || /^[+\d][\d\s().-]{5,}$/.test(value),
    "Ce numéro semble incomplet.",
  ),
  location: optionalText(200, "200 caractères maximum."),
  description: optionalText(
    DESCRIPTION_MAX_LENGTH,
    `${DESCRIPTION_MAX_LENGTH} caractères maximum.`,
  ),
  cancellationPolicy: optionalText(1000, "1000 caractères maximum."),
});

export const onboardingSchema = identityStepSchema
  .extend(slugStepSchema.shape)
  .extend(preferencesStepSchema.shape)
  .extend(detailsStepSchema.shape);

// Which step owns each field — used to send the user back to the right step
// when the backend rejects a field.
export const fieldStep: Record<string, number> = {
  firstName: 0,
  lastName: 0,
  businessName: 0,
  slug: 1,
  timezone: 2,
  minimumBookingNoticeMinutes: 2,
  maximumBookingAdvanceDays: 2,
  bufferMinutes: 2,
  phone: 3,
  location: 3,
  description: 3,
  cancellationPolicy: 3,
};
