import "server-only";

import { z } from "zod";

import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import type { RetentionReportDto } from "../contract";

// The retention report (public.crm_retention_report, retention-v1): the
// cohorts of the last 12 months, computed by PostgreSQL in business time
// under the user's session (row level security applies). Read only.

export const windowDaysSchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(90),
]);

export const retentionInputSchema = z
  .object({ windowDays: windowDaysSchema })
  .strict();

const reportSchema = z.object({
  definitionVersion: z.string(),
  windowDays: windowDaysSchema,
  asOf: z.string(),
  timeZone: z.string(),
  minCohortSize: z.number().int().positive(),
  cohorts: z.array(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      size: z.number().int().positive(),
      returned: z.number().int().nonnegative(),
      fullyObserved: z.boolean(),
    }),
  ),
});

export async function readRetentionReport(
  client: AppSupabaseClient,
  context: { businessId: string },
  windowDays: RetentionReportDto["windowDays"],
  asOf?: string,
): Promise<RetentionReportDto> {
  const { data, error } = await client.rpc("crm_retention_report", {
    p_business_id: context.businessId,
    p_window_days: windowDays,
    ...(asOf ? { p_as_of: asOf } : {}),
  });
  if (error) throw databaseException(error);

  const parsed = reportSchema.safeParse(data);
  if (!parsed.success)
    throw new AppException("internal", { cause: parsed.error });
  return { ...parsed.data, asOf: new Date(parsed.data.asOf).toISOString() };
}
