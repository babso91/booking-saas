import "server-only";

import { z } from "zod";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  exportJobSchema,
  exportRowsSchema,
  type ExportJobDto,
  type ExportRows,
  type ExportScope,
} from "./model";

// Every call runs as her (RLS and the owner check in the database).

export async function listExports(
  client: AppSupabaseClient,
  businessId: string,
): Promise<ExportJobDto[]> {
  const { data, error } = await client.rpc("crm_export_list", {
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return z.array(exportJobSchema).parse(data);
}

export async function requestExport(
  client: AppSupabaseClient,
  businessId: string,
  input: { scope: ExportScope; requestId: string },
): Promise<ExportJobDto> {
  const { data, error } = await client.rpc("crm_export_request", {
    p_business_id: businessId,
    p_request_id: input.requestId,
    p_scope: input.scope,
  });
  if (error) throw databaseException(error);
  return exportJobSchema.parse(data);
}

export async function revokeExport(
  client: AppSupabaseClient,
  businessId: string,
  jobId: string,
): Promise<ExportJobDto> {
  const { data, error } = await client.rpc("crm_export_revoke", {
    p_business_id: businessId,
    p_job_id: jobId,
  });
  if (error) throw databaseException(error);
  return exportJobSchema.parse(data);
}

/** One download: checked again, counted, read now. */
export async function readExportRows(
  client: AppSupabaseClient,
  businessId: string,
  jobId: string,
): Promise<ExportRows> {
  const { data, error } = await client.rpc("crm_export_rows", {
    p_business_id: businessId,
    p_job_id: jobId,
  });
  if (error) throw databaseException(error);
  return exportRowsSchema.parse(data);
}
