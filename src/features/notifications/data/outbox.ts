import "server-only";

import { z } from "zod";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Json } from "@/types/database.generated";

import type { EmailMessage, FailureOutcome } from "../transport/types";

// The worker side of public.email_events. Every function below is
// executable by the service role only; each is a compare-and-set on the
// claim, so a worker whose lease expired never overwrites a newer claim.

export async function claimEmails(
  admin: AppSupabaseClient,
  options: { limit: number; perBusiness: number; businessId?: string },
): Promise<unknown[]> {
  const { data, error } = await admin.rpc("email_outbox_claim", {
    p_limit: options.limit,
    p_per_business: options.perBusiness,
    p_business_id: options.businessId,
  });
  if (error) throw databaseException(error);
  return Array.isArray(data) ? data : [];
}

export type PreparedEmail =
  | { action: "send"; message: EmailMessage }
  | { action: "cancelled"; code: string }
  | { action: "rerender" | "unconfirmed" | "invalid" | "stale" };

const preparedSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    message: z.object({
      to: z.string(),
      from: z.string(),
      replyTo: z.string().optional(),
      subject: z.string(),
      text: z.string(),
      html: z.string(),
    }),
  }),
  z.object({ action: z.literal("cancelled"), code: z.string() }),
  z.object({
    action: z.enum(["rerender", "unconfirmed", "invalid", "stale"]),
  }),
]);

/**
 * Right before the provider call, under a lock on the appointment: whether
 * the claimed email still applies, and the exact message to send (the
 * frozen one when it was already handed to the provider, else `message`,
 * frozen now; `message` is then ignored). Anything but "send" means: do not call the provider.
 */
export async function prepareEmail(
  admin: AppSupabaseClient,
  claim: { id: string; claimId: string },
  appointmentVersion: number,
  message: EmailMessage,
): Promise<PreparedEmail> {
  const { data, error } = await admin.rpc("email_outbox_prepare", {
    p_id: claim.id,
    p_claim_id: claim.claimId,
    p_appointment_version: appointmentVersion,
    p_message: message as unknown as Json,
  });
  if (error) throw databaseException(error);
  return preparedSchema.parse(data);
}

/** False when the claim is no longer current (nothing recorded). */
export async function completeEmail(
  admin: AppSupabaseClient,
  claim: { id: string; claimId: string },
  providerMessageId: string | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc("email_outbox_complete", {
    p_id: claim.id,
    p_claim_id: claim.claimId,
    p_provider_message_id: providerMessageId ?? undefined,
  });
  if (error) throw databaseException(error);
  return data === true;
}

/** The new status (pending: retried later; failed), or null for a stale claim. */
export async function failEmail(
  admin: AppSupabaseClient,
  claim: { id: string; claimId: string },
  code: string,
  outcome: FailureOutcome,
): Promise<"pending" | "failed" | null> {
  const { data, error } = await admin.rpc("email_outbox_fail", {
    p_id: claim.id,
    p_claim_id: claim.claimId,
    p_error_code: code,
    p_outcome: outcome,
  });
  if (error) throw databaseException(error);
  return data === "pending" || data === "failed" ? data : null;
}

export async function releaseEmail(
  admin: AppSupabaseClient,
  claim: { id: string; claimId: string },
): Promise<boolean> {
  const { data, error } = await admin.rpc("email_outbox_release", {
    p_id: claim.id,
    p_claim_id: claim.claimId,
  });
  if (error) throw databaseException(error);
  return data === true;
}
