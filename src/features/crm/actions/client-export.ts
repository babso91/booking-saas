"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";

import { clientIdSchema } from "../schemas/crm";

/**
 * Everything the business holds about one of its customers, as one JSON
 * document (Higani point 205: her right of access). Owner or admin only;
 * read-only. See supabase/migrations/20261121140000_client_data_export.sql.
 */
export async function exportClientDataAction(input: unknown) {
  return runBusinessAction(
    clientIdSchema,
    input,
    async ({ client, businessId, role }, { clientId }) => {
      if (role === "practitioner") throw new AppException("forbidden");
      const { data, error } = await client.rpc("privacy_export_client", {
        p_business_id: businessId,
        p_client_id: clientId,
      });
      if (error) throw databaseException(error);
      return data;
    },
  );
}

/**
 * Erases her personal data in this business (Higani point 205): her record
 * and appointments anonymised, notes, forms, consents and access deleted,
 * nothing emailed. Refused while an appointment is to come. Owner or admin
 * only. See supabase/migrations/20261122100000_client_erasure.sql.
 */
export async function eraseClientDataAction(input: unknown) {
  const result = await runBusinessAction(
    clientIdSchema.extend({ expectedVersion: z.number().int().min(1) }),
    input,
    async ({ client, businessId, role }, { clientId, expectedVersion }) => {
      if (role === "practitioner") throw new AppException("forbidden");
      const { data, error } = await client.rpc("privacy_erase_client", {
        p_business_id: businessId,
        p_client_id: clientId,
        p_expected_version: expectedVersion,
      });
      if (error) throw databaseException(error);
      return data as { erased: boolean; erasedAt: string };
    },
  );
  if (result.ok) revalidatePath("/app/clients");
  return result;
}
