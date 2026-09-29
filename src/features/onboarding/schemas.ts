import { z } from "zod";

import { getSlugIssue, slugify, slugIssueMessages } from "./slug";
import { isValidTimezone } from "./settings";

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((value) => (value ? value : undefined));

// Limits mirror completeOnboardingSchema (src/features/onboarding/schemas/
// onboarding.ts) and public.complete_onboarding, which remain the authority.
export const NAME_MAX_LENGTH = 80;
export const BUSINESS_NAME_MAX_LENGTH = 120;
export const PHONE_PATTERN = /^\+?[0-9 ().-]{6,30}$/;

export const identityStepSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, "Indique ton prénom.")
    .max(NAME_MAX_LENGTH, `${NAME_MAX_LENGTH} caractères maximum.`),
  lastName: z
    .string()
    .trim()
    .min(1, "Indique ton nom.")
    .max(NAME_MAX_LENGTH, `${NAME_MAX_LENGTH} caractères maximum.`),
  businessName: z
    .string()
    .trim()
    .min(1, "Indique le nom de ton activité.")
    .max(
      BUSINESS_NAME_MAX_LENGTH,
      `${BUSINESS_NAME_MAX_LENGTH} caractères maximum.`,
    ),
});

// Sends the previewed normalisation; the server normalises again and its
// result is what gets stored and displayed afterwards.
export const slugStepSchema = z.object({
  slug: z
    .string()
    .superRefine((slug, ctx) => {
      const issue = getSlugIssue(slug);
      if (issue)
        ctx.addIssue({ code: "custom", message: slugIssueMessages[issue] });
    })
    .transform(slugify),
});

export const preferencesStepSchema = z.object({
  timezone: z.string().refine(isValidTimezone, "Fuseau horaire inconnu."),
  minimumBookingNoticeMinutes: z.number().int().min(0).max(10080),
  maximumBookingAdvanceDays: z.number().int().min(1).max(365),
  bufferMinutes: z.number().int().min(0).max(240),
});

// Intentionally shorter than the backend limit (1000): onboarding asks for a
// short presentation; the full description belongs to the settings screen.
export const DESCRIPTION_MAX_LENGTH = 300;

export const detailsStepSchema = z.object({
  phone: optionalText(30, "30 caractères maximum.").refine(
    (value) => !value || PHONE_PATTERN.test(value),
    "Ce numéro semble incomplet.",
  ),
  location: optionalText(200, "200 caractères maximum."),
  description: optionalText(
    DESCRIPTION_MAX_LENGTH,
    `${DESCRIPTION_MAX_LENGTH} caractères maximum.`,
  ),
  cancellationPolicy: optionalText(2000, "2000 caractères maximum."),
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
