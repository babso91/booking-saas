"use server";

import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { AppException } from "@/lib/errors";

import { listExports, requestExport, revokeExport } from "./data";
import { exportScopeSchema } from "./model";

// The four actions of the export screen (CrmExportActions, PR #74). The
// owner check is the database's; these only resolve her business.

export async function listCrmExportsAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listExports(client, businessId),
  );
}

export async function requestCrmExportAction(input: unknown) {
  return runBusinessAction(
    z.object({ scope: exportScopeSchema, requestId: z.uuid() }),
    input,
    ({ client, businessId }, data) => requestExport(client, businessId, data),
  );
}

/**
 * The private link, asked when she clicks: the export must still be hers
 * and ready. The link itself is checked again when it is opened, and gives
 * nothing to another session.
 */
export async function downloadCrmExportAction(jobId: unknown) {
  return runBusinessAction(
    z.uuid(),
    jobId,
    async ({ client, businessId }, id) => {
      const job = (await listExports(client, businessId)).find(
        (item) => item.jobId === id,
      );
      if (!job || job.status !== "ready")
        throw new AppException("export_expired");
      return { url: `/api/crm-export/${id}` };
    },
  );
}

export async function revokeCrmExportAction(jobId: unknown) {
  return runBusinessAction(z.uuid(), jobId, ({ client, businessId }, id) =>
    revokeExport(client, businessId, id),
  );
}
