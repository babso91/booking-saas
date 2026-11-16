import { z } from "zod";

// Inputs of « répéter un rendez-vous » (docs/APPOINTMENT_SERIES_CONTRACT.md).
// PostgreSQL computes the dates, the quote and every check again.

export const seriesPreviewSchema = z.object({
  clientId: z.uuid(),
  serviceId: z.uuid(),
  optionChoiceIds: z.array(z.uuid()).max(50),
  /** Wall clock in the business's time zone, `YYYY-MM-DDTHH:MM[:SS]`. */
  firstLocalStart: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
      "Date et heure locales attendues.",
    ),
  repeatEveryWeeks: z.number().int().min(1).max(52),
  end: z.union([
    z.object({ count: z.number().int().min(1).max(12) }),
    z.object({ untilLocalDate: z.iso.date() }),
  ]),
});

export const seriesCommitSchema = z.object({
  requestId: z.uuid(),
  previewVersion: z.uuid(),
  selected: z
    .array(
      z.object({
        key: z.string().min(1).max(16),
        startsAt: z.iso.datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(12),
});

export type SeriesPreviewInput = z.output<typeof seriesPreviewSchema>;
export type SeriesCommitInput = z.output<typeof seriesCommitSchema>;
