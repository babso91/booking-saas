"use server";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { listBusinessClients } from "@/features/crm/data/directory";
import { getClientRelationshipProfile } from "@/features/crm/data/profile";
import { listClientTimeline } from "@/features/crm/data/timeline";
import {
  clientIdSchema,
  clientTimelineSchema,
  listClientsSchema,
} from "@/features/crm/schemas/crm";

// Official server interface of the CRM read model (professionals only).
// Every action resolves the business from the session (runBusinessAction),
// validates its input and returns an ActionResult; nothing here writes.
// Contract: docs/CRM_RELATIONSHIP_READ_MODEL.md.

/** One page of the customer directory. */
export async function listClientsAction(input: unknown) {
  return runBusinessAction(
    listClientsSchema,
    input,
    ({ client, businessId, timezone }, data) =>
      listBusinessClients(client, { businessId, timezone }, data),
  );
}

/** One customer's profile: record, overview, upcoming appointments. */
export async function getClientProfileAction(input: unknown) {
  return runBusinessAction(
    clientIdSchema,
    input,
    ({ client, businessId, timezone }, { clientId }) =>
      getClientRelationshipProfile(client, { businessId, timezone }, clientId),
  );
}

/** One page of a customer's relationship timeline, newest first. */
export async function listClientTimelineAction(input: unknown) {
  return runBusinessAction(
    clientTimelineSchema,
    input,
    ({ client, businessId, timezone }, data) =>
      listClientTimeline(client, { businessId, timezone }, data),
  );
}
