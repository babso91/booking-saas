"use server";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";

import { readRetentionReport, retentionInputSchema } from "./server/report";

// Server interface of the retention report (professionals only). The
// business comes from the session, never from the input; nothing writes.

export async function readRetentionAction(input: unknown) {
  return runBusinessAction(
    retentionInputSchema,
    input,
    ({ client, businessId }, { windowDays }) =>
      readRetentionReport(client, { businessId }, windowDays),
  );
}
