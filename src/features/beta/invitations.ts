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

/**
 * Once her account exists: accepts the invitation for the account of
 * `email` (found by the database), which gets beta access. Idempotent for
 * that account. Throws as assertInvitation does.
 */
export async function acceptInvitation(
  service: AppSupabaseClient,
  token: string | undefined,
  email: string,
): Promise<void> {
  const { data, error } = await service.rpc("accept_beta_invitation", {
    p_token_hash: hashOf(token),
    p_email: email,
  });
  if (error) throw databaseException(error);
  const state = (data ?? "invalid") as
    InvitationState | "accepted" | "account_missing";
  if (state === "accepted") return;
  if (state === "account_missing") {
    throw new AppException("internal", {
      message: "Invitation accepted before its account exists.",
    });
  }
  throw new AppException(
    state === "valid" ? "invitation_invalid" : refusal[state],
  );
}

/**
 * The same, when Auth's answer leaves unsure whether her account exists:
 * accepted if it does, nothing otherwise. Never throws (the caller has its
 * own answer to give); a failure is logged without the address or token.
 */
export async function acceptInvitationIfAccount(
  service: AppSupabaseClient,
  token: string | undefined,
  email: string,
): Promise<void> {
  try {
    const { data, error } = await service.rpc("accept_beta_invitation", {
      p_token_hash: hashOf(token),
      p_email: email,
    });
    if (error) console.error("Beta invitation acceptance failed", error.code);
    else if (data !== "accepted" && data !== "account_missing") {
      console.warn("Beta invitation not accepted", data);
    }
  } catch (cause) {
    console.error("Beta invitation acceptance failed", cause);
  }
}

/** May the signed-in user create her business? */
export async function hasBetaAccess(
  client: AppSupabaseClient,
): Promise<boolean> {
  const { data, error } = await client.rpc("my_beta_access");
  if (error) throw databaseException(error);
  return data === true;
}
