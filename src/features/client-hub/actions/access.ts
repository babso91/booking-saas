"use server";

import { revalidatePath } from "next/cache";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  getClientHubAccess,
  setClientHubAccess,
} from "@/features/client-hub/data/client-hub";
import {
  clientHubAccessSchema,
  setClientHubAccessSchema,
} from "@/features/client-hub/schemas/client-hub";

// Professional side of the Client Hub: a member vouches that a CRM record
// belongs to the person who controls its current email, or withdraws it.
// Contract: docs/CLIENT_HUB_CONTRACT.md.

export async function getClientHubAccessAction(input: unknown) {
  return runBusinessAction(
    clientHubAccessSchema,
    input,
    ({ client, businessId }, data) =>
      getClientHubAccess(client, businessId, data.clientId),
  );
}

/** Grants (`granted: true`) or revokes Client Hub access; idempotent. */
export async function setClientHubAccessAction(input: unknown) {
  const result = await runBusinessAction(
    setClientHubAccessSchema,
    input,
    ({ client, businessId }, data) =>
      setClientHubAccess(client, businessId, data),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}
