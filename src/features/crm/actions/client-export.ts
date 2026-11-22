"use server";

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
      const { data, error } = await client.rpc("crm_export_client", {
        p_business_id: businessId,
        p_client_id: clientId,
      });
      if (error) throw databaseException(error);
      return data;
    },
  );
}
