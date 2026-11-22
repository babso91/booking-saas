import "server-only";

import { z } from "zod";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Records that look alike (point 147), for her to check: never merged.
// Contract: docs/CRM_CUSTOMER_CONTRACT.md, « Doublons possibles ».

const summarySchema = z.object({
  id: z.uuid(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  createdAt: z.string(),
  pastVisits: z.number().int(),
  upcoming: z.number().int(),
  lastVisitAt: z.string().nullable(),
});

const candidatesSchema = z.object({
  total: z.number().int(),
  pairs: z.array(
    z.object({
      reasons: z.array(z.enum(["phone", "name"])),
      clients: z.tuple([summarySchema, summarySchema]),
    }),
  ),
});

export type DuplicateClient = z.infer<typeof summarySchema>;
export type DuplicateCandidates = z.infer<typeof candidatesSchema>;
export type DuplicatePair = DuplicateCandidates["pairs"][number];

export async function listDuplicateCandidates(
  client: AppSupabaseClient,
  businessId: string,
): Promise<DuplicateCandidates> {
  const { data, error } = await client.rpc("crm_duplicate_candidates", {
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return candidatesSchema.parse(data);
}

/** « Ce n'est pas la même personne » (dismissed) or its undo. */
export async function setDuplicateDismissed(
  client: AppSupabaseClient,
  businessId: string,
  input: { clientId: string; otherId: string; dismissed: boolean },
): Promise<{ dismissed: boolean }> {
  const { data, error } = await client.rpc("crm_set_duplicate_dismissed", {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_other_id: input.otherId,
    p_dismissed: input.dismissed,
  });
  if (error) throw databaseException(error);
  return z.object({ dismissed: z.boolean() }).parse(data);
}
