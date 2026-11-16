import "server-only";

import type {
  SeriesCommitInput,
  SeriesPreviewInput,
} from "@/features/appointment-series/schemas";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Series of appointments (docs/APPOINTMENT_SERIES_CONTRACT.md); every rule is
// PostgreSQL's (20261115130000_appointment_series.sql).

export type SeriesPreview = {
  previewVersion: string;
  timeZone: string;
  quote: { serviceName: string; durationMinutes: number; priceCents: number };
  occurrences: {
    key: string;
    requestedLocalStart: string;
    utcCandidates: string[];
    state:
      | "available"
      | "conflict"
      | "ambiguous"
      | "nonexistent"
      | "outside_horizon";
  }[];
};

export type SeriesCommitted = { seriesId: string; appointmentIds: string[] };

type DbError = Parameters<typeof databaseException>[0] & { details?: string };
type Rpc = { data: unknown; error: DbError | null };
type RpcCaller = (fn: string, args: object) => Promise<Rpc>;

async function call<T>(client: AppSupabaseClient, fn: string, args: object) {
  const { data, error } = await (client.rpc as unknown as RpcCaller)(fn, args);
  if (error) {
    // The dates in conflict are named (their keys) in DETAIL.
    if (error.message === "calendar_conflict") {
      throw new AppException("calendar_conflict", {
        cause: error,
        fieldErrors: {
          keys: (error.details ?? "").split(",").filter(Boolean),
        },
      });
    }
    throw databaseException(error);
  }
  return data as T;
}

export const previewSeries = (
  client: AppSupabaseClient,
  businessId: string,
  input: SeriesPreviewInput,
) =>
  call<SeriesPreview>(client, "preview_appointment_series", {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_service_id: input.serviceId,
    p_option_choice_ids: input.optionChoiceIds,
    p_first_local_start: input.firstLocalStart,
    p_repeat_every_weeks: input.repeatEveryWeeks,
    p_count: "count" in input.end ? input.end.count : null,
    p_until_local_date:
      "untilLocalDate" in input.end ? input.end.untilLocalDate : null,
  });

export const commitSeries = (
  client: AppSupabaseClient,
  businessId: string,
  input: SeriesCommitInput,
) =>
  call<SeriesCommitted>(client, "commit_appointment_series", {
    p_business_id: businessId,
    p_request_id: input.requestId,
    p_preview_version: input.previewVersion,
    p_selected: input.selected,
  });
