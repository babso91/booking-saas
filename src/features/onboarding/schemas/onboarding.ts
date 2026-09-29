import { z } from "zod";

import { isValidTimeZone } from "@/lib/time/zoned";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

// Mirrors public.complete_onboarding, which re-validates every field. The
// slug is sent as typed: the server normalises it (see checkSlugAction).
export const completeOnboardingSchema = z.object({
  firstName: z.string().trim().min(1, "Le prénom est obligatoire.").max(80),
  lastName: z.string().trim().min(1, "Le nom est obligatoire.").max(80),
  businessName: z
    .string()
    .trim()
    .min(1, "Le nom de l’activité est obligatoire.")
    .max(120),
  slug: z
    .string()
    .trim()
    .min(1, "L’adresse de la page est obligatoire.")
    .max(200),
  timezone: z
    .string()
    .trim()
    .default("Europe/Paris")
    .refine(isValidTimeZone, "Fuseau horaire inconnu."),
  description: optionalText(1000),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .optional()
    .transform((value) => (value ? value : undefined))
    .pipe(z.email("Adresse email invalide.").optional()),
  phone: optionalText(30).pipe(
    z
      .string()
      .regex(/^\+?[0-9 ().-]{6,30}$/, "Numéro de téléphone invalide.")
      .optional(),
  ),
  location: optionalText(200),
  cancellationPolicy: optionalText(2000),
  minimumBookingNoticeMinutes: z.number().int().min(0).max(10_080).default(120),
  maximumBookingAdvanceDays: z.number().int().min(1).max(365).default(90),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
});

export const checkSlugSchema = z.object({
  slug: z.string().max(200),
});

export type CompleteOnboardingInput = z.output<typeof completeOnboardingSchema>;
