"use server";

import { revalidatePath } from "next/cache";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  createClient,
  getClientRecord,
  updateClient,
} from "@/features/crm/data/client-management";
import {
  createClientSchema,
  updateClientSchema,
} from "@/features/crm/schemas/client-management";
import { clientIdSchema } from "@/features/crm/schemas/crm";

// Official server interface of customer management (professionals only).
// Every action resolves the business from the session (runBusinessAction),
// validates its input and returns an ActionResult with a stable error code.
// Contract: docs/CRM_CLIENT_MANAGEMENT.md.

/** Pages that show customer names (agenda, CRM) render the new record. */
function revalidateClients() {
  revalidatePath("/app", "layout");
}

/** One customer as an edit form uses it (current values and version). */
export async function getClientRecordAction(input: unknown) {
  return runBusinessAction(
    clientIdSchema,
    input,
    ({ client, businessId }, { clientId }) =>
      getClientRecord(client, { businessId }, clientId),
  );
}

/**
 * Creates a customer. Idempotent by `requestId` (one per form); an email
 * used by another customer is `client_email_conflict`, naming that customer
 * in `error.conflict`: never a merge.
 */
export async function createClientAction(input: unknown) {
  const result = await runBusinessAction(
    createClientSchema,
    input,
    ({ client, businessId }, data) =>
      createClient(client, { businessId }, data),
  );
  if (result.ok && result.data.created) revalidateClients();
  return result;
}

/**
 * Replaces a customer's identity and contact, based on `expectedVersion`
 * (`stale_client` otherwise). Appointments and queued emails keep the
 * contact they were made with.
 */
export async function updateClientAction(input: unknown) {
  const result = await runBusinessAction(
    updateClientSchema,
    input,
    ({ client, businessId }, data) =>
      updateClient(client, { businessId }, data),
  );
  if (result.ok && result.data.changed) revalidateClients();
  return result;
}
