"use server";

import { revalidatePath } from "next/cache";

import {
  commitSeries,
  previewSeries,
} from "@/features/appointment-series/data";
import {
  seriesCommitSchema,
  seriesPreviewSchema,
} from "@/features/appointment-series/schemas";
import { runBusinessAction } from "@/features/businesses/actions/run-business-action";

// « Répéter un rendez-vous » (docs/APPOINTMENT_SERIES_CONTRACT.md). The
// preview reserves nothing; the commit creates every occurrence or none.

export async function previewSeriesAction(input: unknown) {
  return runBusinessAction(
    seriesPreviewSchema,
    input,
    ({ client, businessId }, data) => previewSeries(client, businessId, data),
  );
}

export async function commitSeriesAction(input: unknown) {
  const result = await runBusinessAction(
    seriesCommitSchema,
    input,
    ({ client, businessId }, data) => commitSeries(client, businessId, data),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}
