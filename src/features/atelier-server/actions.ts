"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// The Atelier, her side (docs/ATELIER_CONTRACT.md): the AtelierActions of
// the screen, owner only. Applying a proposal saves her draft through the
// Studio's own path and never publishes; nothing is charged from here.

type Dto = Record<string, unknown>;

async function rpc(client: AppSupabaseClient, fn: string, args: object) {
  const { data, error } = await (
    client.rpc as unknown as (
      f: string,
      a: object,
    ) => Promise<{
      data: unknown;
      error: Parameters<typeof databaseException>[0] | null;
    }>
  )(fn, args);
  if (error) {
    // stale_site_draft carries her current revision for the screen.
    if (
      error.message === "stale_site_draft" &&
      error.hint &&
      /^\d+$/.test(error.hint)
    ) {
      throw new AppException("stale_site_draft", {
        conflict: { currentRevision: Number(error.hint) },
      });
    }
    throw databaseException(error);
  }
  return data as Dto;
}

const orderSchema = z.object({ orderId: z.uuid() });
const correctionSchema = z.object({
  proposalId: z.uuid(),
  scope: z.string().trim().min(1).max(80),
  requestId: z.uuid(),
});
const rebaseSchema = z.object({ proposalId: z.uuid(), requestId: z.uuid() });
const applySchema = z.object({
  proposalId: z.uuid(),
  expectedDraftRevision: z.number().int().min(0),
  requestId: z.uuid(),
});

export async function readAtelierAction(input: unknown) {
  return runBusinessAction(orderSchema, input, ({ client }, { orderId }) =>
    rpc(client, "atelier_read", { p_order_id: orderId }),
  );
}

/** One included correction, once per request, within the quote's scopes. */
export async function requestAtelierCorrectionAction(input: unknown) {
  return runBusinessAction(correctionSchema, input, ({ client }, data) =>
    rpc(client, "atelier_request_correction", {
      p_proposal_id: data.proposalId,
      p_scope: data.scope,
      p_request_id: data.requestId,
    }),
  );
}

/** The same proposal remade on her current draft: no correction used. */
export async function requestAtelierRebaseAction(input: unknown) {
  return runBusinessAction(rebaseSchema, input, ({ client }, data) =>
    rpc(client, "atelier_request_rebase", {
      p_proposal_id: data.proposalId,
      p_request_id: data.requestId,
    }),
  );
}

/** Saves the proposal as her draft (never published); stale_site_draft otherwise. */
export async function applyAtelierProposalAction(input: unknown) {
  const result = await runBusinessAction(
    applySchema,
    input,
    ({ client }, data) =>
      rpc(client, "atelier_apply", {
        p_proposal_id: data.proposalId,
        p_expected_draft_revision: data.expectedDraftRevision,
        p_request_id: data.requestId,
      }),
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}
