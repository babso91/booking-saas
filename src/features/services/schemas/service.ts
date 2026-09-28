import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

// Mirrors the CHECK constraints on public.services.
const serviceFields = {
  name: z.string().trim().min(1, "Le nom est obligatoire.").max(120),
  description: optionalText(1000),
  durationMinutes: z.number().int().min(5).max(720),
  // Money is always an integer number of cents, never a float.
  priceCents: z.number().int().min(0).max(10_000_000),
  active: z.boolean(),
  displayOrder: z.number().int().min(0).max(10_000),
};

export const serviceIdSchema = z.uuid();

export const createServiceSchema = z.object({
  name: serviceFields.name,
  description: serviceFields.description,
  durationMinutes: serviceFields.durationMinutes,
  priceCents: serviceFields.priceCents,
  active: serviceFields.active.default(true),
  displayOrder: serviceFields.displayOrder.optional(),
});

export const updateServiceSchema = z.object({
  serviceId: serviceIdSchema,
  changes: z
    .object({
      name: serviceFields.name.optional(),
      description: serviceFields.description.optional(),
      durationMinutes: serviceFields.durationMinutes.optional(),
      priceCents: serviceFields.priceCents.optional(),
      active: serviceFields.active.optional(),
      displayOrder: serviceFields.displayOrder.optional(),
    })
    .refine((changes) => Object.values(changes).some((v) => v !== undefined), {
      message: "Aucune modification fournie.",
    }),
});

export const setServiceActiveSchema = z.object({
  serviceId: serviceIdSchema,
  active: z.boolean(),
});

export const reorderServicesSchema = z.object({
  serviceIds: z
    .array(serviceIdSchema)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Une prestation apparaît plusieurs fois.",
    }),
});

export const deleteServiceSchema = z.object({ serviceId: serviceIdSchema });

export type CreateServiceInput = z.output<typeof createServiceSchema>;
export type UpdateServiceInput = z.output<typeof updateServiceSchema>;
