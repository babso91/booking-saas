"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  listDuplicateCandidates,
  setDuplicateDismissed,
} from "@/features/crm/data/duplicates";

// Records that look alike (point 147): owner or admin, never merged.

/** The pairs to check, strongest first (50 at most, with the total). */
export async function listDuplicateCandidatesAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listDuplicateCandidates(client, businessId),
  );
}

const dismissSchema = z
  .object({
    clientId: z.uuid(),
    otherId: z.uuid(),
    dismissed: z.boolean(),
  })
  .refine((value) => value.clientId !== value.otherId, {
    path: ["otherId"],
  });

/** « Ce n'est pas la même personne », or its undo. Idempotent. */
export async function setDuplicateDismissedAction(input: unknown) {
  const result = await runBusinessAction(
    dismissSchema,
    input,
    ({ client, businessId }, data) =>
      setDuplicateDismissed(client, businessId, data),
  );
  if (result.ok) revalidatePath("/app/clients");
  return result;
}
