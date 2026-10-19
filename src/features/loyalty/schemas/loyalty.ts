import { z } from "zod";

// Inputs of the loyalty Server Actions. They mirror the checks of the SQL
// functions (20261020090000_loyalty_engine.sql), which remain the authority.

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

/** A version as last read (0: the business has no program row yet). */
const versionSchema = z.number().int().min(0).max(2_147_483_647);

export const accrualModeSchema = z.enum(["appointment", "spend"]);
export const rewardTypeSchema = z.enum([
  "percentage_discount",
  "fixed_discount",
  "free_service",
]);

/**
 * Points per 100 minor units of the price, as an exact decimal string
 * ("1", "0.5", "2.25"): 0.01 to 100, at most 4 decimals. A string, so the
 * value never goes through a lossy computation before PostgreSQL's NUMERIC.
 */
export const pointsPerEuroSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, "Nombre décimal attendu (ex. 1,5 → 1.5).")
  .refine((value) => {
    const [units, decimals = ""] = value.split(".");
    const tenThousandths =
      Number(units) * 10_000 + Number(decimals.padEnd(4, "0"));
    return tenThousandths >= 100 && tenThousandths <= 1_000_000;
  }, "Entre 0,01 et 100 points.");

export const configureProgramSchema = z
  .object({
    expectedVersion: versionSchema,
    active: z.boolean(),
    accrualMode: accrualModeSchema,
    pointsPerCompletedAppointment: z.number().int().min(1).max(10_000),
    pointsPerEuro: pointsPerEuroSchema.nullish(),
  })
  .superRefine((value, context) => {
    if (value.accrualMode === "spend" && !value.pointsPerEuro) {
      context.addIssue({
        code: "custom",
        path: ["pointsPerEuro"],
        message: "Obligatoire pour des points au montant.",
      });
    }
    if (value.accrualMode === "appointment" && value.pointsPerEuro) {
      context.addIssue({
        code: "custom",
        path: ["pointsPerEuro"],
        message: "Uniquement pour des points au montant.",
      });
    }
  });

export const setServiceRuleSchema = z.object({
  serviceId: z.uuid(),
  /** Points for one completed appointment of this service; null removes the rule. */
  points: z.number().int().min(0).max(10_000).nullable(),
});

const rewardFields = {
  name: z.string().trim().min(1, "Le nom est obligatoire.").max(120),
  description: optionalText(1000),
  pointsRequired: z.number().int().min(1).max(1_000_000),
  /**
   * fixed_discount: amount in minor units of the business currency;
   * percentage_discount: 1-100; free_service: null.
   */
  rewardValue: z.number().int().min(1).max(10_000_000).nullable(),
  /** free_service only: the complimentary service. */
  serviceId: z.uuid().nullable(),
  active: z.boolean(),
};

function checkRewardShape(
  value: {
    rewardType: z.infer<typeof rewardTypeSchema>;
    rewardValue: number | null;
    serviceId: string | null;
  },
  context: z.RefinementCtx,
) {
  if (value.rewardType === "free_service") {
    if (value.rewardValue !== null) {
      context.addIssue({
        code: "custom",
        path: ["rewardValue"],
        message: "Pas de montant pour une prestation offerte.",
      });
    }
    if (value.serviceId === null) {
      context.addIssue({
        code: "custom",
        path: ["serviceId"],
        message: "Choisissez la prestation offerte.",
      });
    }
    return;
  }
  if (value.serviceId !== null) {
    context.addIssue({
      code: "custom",
      path: ["serviceId"],
      message: "Uniquement pour une prestation offerte.",
    });
  }
  if (value.rewardValue === null) {
    context.addIssue({
      code: "custom",
      path: ["rewardValue"],
      message: "La valeur est obligatoire.",
    });
  } else if (
    value.rewardType === "percentage_discount" &&
    value.rewardValue > 100
  ) {
    context.addIssue({
      code: "custom",
      path: ["rewardValue"],
      message: "Entre 1 et 100 %.",
    });
  }
}

export const createRewardSchema = z
  .object({
    ...rewardFields,
    rewardType: rewardTypeSchema,
    active: rewardFields.active.default(true),
    /** One per creation form: a retry of the same command creates nothing more. */
    requestId: z.uuid(),
  })
  .superRefine(checkRewardShape);

/** Every editable field (the type is fixed), on the basis of `expectedVersion`. */
export const updateRewardSchema = z
  .object({
    ...rewardFields,
    rewardId: z.uuid(),
    /** The reward's type as read; it cannot change. */
    rewardType: rewardTypeSchema,
    expectedVersion: versionSchema.min(1),
  })
  .superRefine(checkRewardShape);

export const clientLoyaltySchema = z.object({ clientId: z.uuid() });

export const ledgerPageSchema = z.object({
  clientId: z.uuid(),
  /** `nextCursor` of the previous page; absent for the first. */
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const balancesSchema = z.object({
  /** Restrict to these customers (a directory page); all otherwise. */
  clientIds: z.array(z.uuid()).max(200).optional(),
});

export const redeemRewardSchema = z.object({
  clientId: z.uuid(),
  rewardId: z.uuid(),
  /** One per redemption intent: a retry never spends twice. */
  requestId: z.uuid(),
});

export const fulfilRedemptionSchema = z.object({
  redemptionId: z.uuid(),
  /** The visit at which it was applied (same customer), if any. */
  appointmentId: z.uuid().nullish(),
});

export const cancelRedemptionSchema = z.object({
  redemptionId: z.uuid(),
  reason: optionalText(500),
});

export const adjustPointsSchema = z.object({
  clientId: z.uuid(),
  requestId: z.uuid(),
  pointsDelta: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .refine((value) => value !== 0, "Indiquez un nombre de points non nul."),
  reason: z.string().trim().min(1, "Le motif est obligatoire.").max(500),
});

export const reverseAdjustmentSchema = z.object({
  entryId: z.uuid(),
  reason: optionalText(500),
});

export type ConfigureProgramInput = z.output<typeof configureProgramSchema>;
export type CreateRewardInput = z.output<typeof createRewardSchema>;
export type UpdateRewardInput = z.output<typeof updateRewardSchema>;
export type LedgerPageInput = z.output<typeof ledgerPageSchema>;
export type AdjustPointsInput = z.output<typeof adjustPointsSchema>;
