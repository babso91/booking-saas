import { z } from "zod";

import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import { optionChoiceIdsSchema } from "@/features/catalog/schemas";

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
  /** One per booking form: a retry of the same booking never books twice. */
  requestId: z.uuid(),
  /**
   * The answers chosen for the service's options, one per answered group.
   * Absent: none (a client written before options books as it always did).
   * The price and the duration are always the server's.
   */
  optionChoiceIds: optionChoiceIdsSchema.default([]),
  /**
   * What she was shown (optional): if the server's price or duration
   * differs, nothing is booked (`quote_changed`).
   */
  expectedPriceCents: z.number().int().min(0).max(2_147_483_647).optional(),
  expectedDurationMinutes: z.number().int().min(5).max(720).optional(),
  phone: optionalText(
    z
      .string()
      .trim()
      .regex(/^\+?[0-9 ().-]{6,30}$/, "Numéro de téléphone invalide.")
      .optional(),
  ),
});

/** Without `optionChoiceIds`: none (the shape callers had before options). */
export type CreatePublicBookingInput = Omit<
  z.output<typeof createPublicBookingSchema>,
  "optionChoiceIds"
> & { optionChoiceIds?: string[] };
