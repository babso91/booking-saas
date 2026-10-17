import "server-only";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

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

/**
 * Right before the send: true when the claimed email still applies. False:
 * it was cancelled (appointment cancelled or moved meanwhile) or the claim
 * is no longer current; it must not be sent.
 */
export async function verifyEmail(
  admin: AppSupabaseClient,
  claim: { id: string; claimId: string },
): Promise<boolean> {
  const { data, error } = await admin.rpc("email_outbox_verify", {
    p_id: claim.id,
    p_claim_id: claim.claimId,
  });
  if (error) throw databaseException(error);
  return data === true;
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
  permanent: boolean,
): Promise<"pending" | "failed" | null> {
  const { data, error } = await admin.rpc("email_outbox_fail", {
    p_id: claim.id,
    p_claim_id: claim.claimId,
    p_error_code: code,
    p_permanent: permanent,
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
