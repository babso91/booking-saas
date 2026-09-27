import { z } from "zod";

import { businessSlugSchema } from "@/features/businesses/schemas/slug";

const optionalText = <T extends z.ZodType<string | undefined>>(schema: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    schema,
  );

// Same rules as public.create_public_booking, which re-validates everything:
// this schema only gives the frontend precise field errors.
export const createPublicBookingSchema = z.object({
  slug: businessSlugSchema,
  serviceId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  firstName: z.string().trim().min(1, "Le prénom est obligatoire.").max(120),
  lastName: optionalText(z.string().trim().max(120).optional()),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email("Adresse email invalide.")),
  phone: optionalText(
    z
      .string()
      .trim()
      .regex(/^\+?[0-9 ().-]{6,30}$/, "Numéro de téléphone invalide.")
      .optional(),
  ),
});

export type CreatePublicBookingInput = z.output<
  typeof createPublicBookingSchema
>;
