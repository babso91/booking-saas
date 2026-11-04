import { z } from "zod";

import { catalogLimits } from "@/features/catalog/model";

const versionSchema = z.number().int().min(1).max(2_147_483_647);
const categoryName = z
  .string()
  .trim()
  .min(1, "Le nom est obligatoire.")
  .max(catalogLimits.categoryName);

export const createCategorySchema = z.object({
  name: categoryName,
  visible: z.boolean().default(true),
  /** One per creation form: a retry creates nothing more. */
  requestId: z.uuid(),
});

/** Only what changes, on the basis of the version it was read at. */
export const updateCategorySchema = z
  .object({
    categoryId: z.uuid(),
    expectedVersion: versionSchema,
    name: categoryName.optional(),
    visible: z.boolean().optional(),
  })
  .refine((input) => input.name !== undefined || input.visible !== undefined, {
    message: "Aucune modification fournie.",
  });

export const reorderCategoriesSchema = z.object({
  categoryIds: z
    .array(z.uuid())
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Une catégorie apparaît plusieurs fois.",
    }),
});

export const deleteCategorySchema = z.object({ categoryId: z.uuid() });

const choiceSchema = z.object({
  /** Absent or null: a new answer. */
  id: z.uuid().nullish(),
  label: z.string().trim().min(1).max(catalogLimits.choiceLabel),
  priceDeltaCents: z
    .number()
    .int()
    .min(0)
    .max(catalogLimits.maxPriceDeltaCents),
  durationDeltaMinutes: z
    .number()
    .int()
    .min(0)
    .max(catalogLimits.maxDurationDelta),
});

const optionSchema = z.object({
  /** Absent or null: a new group. */
  id: z.uuid().nullish(),
  question: z.string().trim().min(1).max(catalogLimits.question),
  required: z.boolean(),
  choices: z.array(choiceSchema).min(1).max(catalogLimits.maxChoices),
});

const idsSchema = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      {
        message: "Un identifiant apparaît plusieurs fois.",
      },
    );

/**
 * All the options of a service, in order. Nothing is deleted by omission:
 * an existing group or answer left out must be listed in `deletedOptionIds`
 * / `deletedChoiceIds`, otherwise the save is refused (`options_incomplete`),
 * so an editor that loaded the options partially can never delete what it
 * did not see.
 */
export const setServiceOptionsSchema = z.object({
  serviceId: z.uuid(),
  expectedVersion: versionSchema,
  options: z.array(optionSchema).max(catalogLimits.maxOptions),
  deletedOptionIds: idsSchema(100).default([]),
  deletedChoiceIds: idsSchema(1000).default([]),
});

/** The answers chosen when booking: one id per answered group. */
export const optionChoiceIdsSchema = z
  .array(z.uuid())
  .max(50)
  .refine(
    (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
    { message: "Une réponse apparaît plusieurs fois." },
  );

export type CreateCategoryInput = z.output<typeof createCategorySchema>;
export type UpdateCategoryInput = z.output<typeof updateCategorySchema>;
/** Without deletions: `deletedOptionIds` / `deletedChoiceIds` default to none. */
export type SetServiceOptionsInput = Omit<
  z.output<typeof setServiceOptionsSchema>,
  "deletedOptionIds" | "deletedChoiceIds"
> & { deletedOptionIds?: string[]; deletedChoiceIds?: string[] };
