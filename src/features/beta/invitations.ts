import "server-only";

import {
  INVITATION_TOKEN_PATTERN,
  hashInvitationToken,
} from "@/features/beta/token";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// The private beta's invitations, server side only (docs/BETA_ACCESS.md).
// Every check is made by the database, with the service client; the token
// is hashed here and never stored nor logged.

type InvitationState =
  "valid" | "invalid" | "email_mismatch" | "used" | "expired";

const refusal: Record<
  Exclude<InvitationState, "valid">,
  AppException["code"]
> = {
  invalid: "invitation_invalid",
  email_mismatch: "invitation_email_mismatch",
  used: "invitation_used",
  expired: "invitation_expired",
};

function hashOf(token: string | undefined): string {
  if (!token) throw new AppException("beta_invitation_required");
  if (!INVITATION_TOKEN_PATTERN.test(token)) {
    throw new AppException("invitation_invalid");
  }
  return hashInvitationToken(token);
}

/**
 * Before creating her account: throws unless `token` is a valid invitation
 * for `email` (`beta_invitation_required` without one, `invitation_invalid`,
 * `invitation_email_mismatch`, `invitation_used`, `invitation_expired`).
 */
export async function assertInvitation(
  service: AppSupabaseClient,
  token: string | undefined,
  email: string,
): Promise<void> {
  const { data, error } = await service.rpc("check_beta_invitation", {
    p_token_hash: hashOf(token),
    p_email: email,
  });
  if (error) throw databaseException(error);
  const state = (data ?? "invalid") as InvitationState;
  if (state !== "valid") throw new AppException(refusal[state]);
}

export type InvitedAccount =
  | { state: "none" }
  | { state: "unconfirmed"; userId: string }
  | { state: "confirmed"; userId: string };

/**
 * The account of the invited address, if any (throws as assertInvitation
 * when the invitation is not valid for it). An `unconfirmed` account may
 * have been created by anyone, with any password: it is never changed for
 * her invitation; she proves the mailbox is hers through a recovery link
 * and sets her own password (completeInvitationAction) before it is
 * accepted.
 */
export async function invitedAccount(
  service: AppSupabaseClient,
  token: string | undefined,
  email: string,
): Promise<InvitedAccount> {
  const { data, error } = await service
    .rpc("beta_invited_account", {
      p_token_hash: hashOf(token),
      p_email: email,
    })
    .single();
  if (error) throw databaseException(error);
  const state = data.state as InvitationState | InvitedAccount["state"];
  if (state === "none") return { state };
  if (state === "unconfirmed" || state === "confirmed") {
    return { state, userId: data.user_id! };
  }
  throw new AppException(
    state === "valid" ? "invitation_invalid" : refusal[state],
  );
}

/**
 * Accepts the invitation for `userId`, the account of the invited address,
 * proven hers by the caller (just created with her password, her password
 * proven, or her mailbox proven and her password set). `proofSessionId`:
 * the session of that proof; only it and sessions opened afterwards use
 * the access, and the caller has ended the others first. Idempotent for
 * that account. Throws as assertInvitation does.
 */
export async function acceptInvitationFor(
  service: AppSupabaseClient,
  token: string | undefined,
  email: string,
  userId: string,
  proofSessionId?: string,
): Promise<void> {
  const { data, error } = await service.rpc("accept_beta_invitation", {
    p_token_hash: hashOf(token),
    p_email: email,
    p_user_id: userId,
    ...(proofSessionId ? { p_proof_session: proofSessionId } : {}),
  });
  if (error) throw databaseException(error);
  const state = (data ?? "invalid") as
    InvitationState | "accepted" | "account_mismatch";
  if (state === "accepted") return;
  if (state === "account_mismatch" || state === "valid") {
    throw new AppException("invitation_invalid");
  }
  throw new AppException(refusal[state]);
}

/** May the signed-in user create her business? */
export async function hasBetaAccess(
  client: AppSupabaseClient,
): Promise<boolean> {
  const { data, error } = await client.rpc("my_beta_access");
  if (error) throw databaseException(error);
  return data === true;
}
