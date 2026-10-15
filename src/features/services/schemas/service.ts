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

/** A service's version as last read (ServiceDto.version). */
const versionSchema = z.number().int().min(1).max(2_147_483_647);

export const createServiceSchema = z.object({
  name: serviceFields.name,
  description: serviceFields.description,
  durationMinutes: serviceFields.durationMinutes,
  priceCents: serviceFields.priceCents,
  active: serviceFields.active.default(true),
  displayOrder: serviceFields.displayOrder.optional(),
  /** One per creation form: a retry of the same command creates nothing more. */
  requestId: z.uuid(),
});

/** Only the changed fields, on the basis of the version they were read at. */
export const updateServiceSchema = z.object({
  serviceId: serviceIdSchema,
  expectedVersion: versionSchema,
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

/** By value (idempotent); with a version, refused if the service changed since. */
export const setServiceActiveSchema = z.object({
  serviceId: serviceIdSchema,
  active: z.boolean(),
  expectedVersion: versionSchema.optional(),
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
