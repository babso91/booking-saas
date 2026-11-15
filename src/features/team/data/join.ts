import "server-only";

import { authException } from "@/features/auth/data/auth-errors";
import {
  sendConfirmation,
  sendRecovery,
} from "@/features/auth/data/credentials";
import { authCallbackUrl } from "@/features/auth/data/redirects";
import {
  currentSessionId,
  endOtherSessions,
} from "@/features/auth/data/session-proof";
import type { SignUpInput } from "@/features/auth/schemas/auth";
import { hashTeamInviteToken } from "@/features/team/data/team";
import { rememberTeamInvitation } from "@/features/team/invitation-cookie";
import { getPublicEnv } from "@/lib/env/public";
import { AppException } from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Joining a team with or without an account (docs/TEAM_CONTRACT.md,
// « Rejoindre l'équipe »). The same rule as the private beta: the
// invitation is never proof that an account is hers; the session that
// proved it is (accept_team_invitation, request_session_trusted).

export const TEAM_INVITATION_PAGE = "/equipe/invitation" as const;

type InvitationState = "valid" | "invalid" | "email_mismatch";
type InvitedAccount =
  { state: "none" } | { state: "unconfirmed" | "confirmed"; userId: string };

function refusal(state: string): AppException {
  return new AppException(
    state === "email_mismatch"
      ? "invitation_email_mismatch"
      : "invitation_invalid",
  );
}

/** The account of the invited address, or throws if the invitation is not valid for it. */
export async function teamInvitedAccount(
  service: AppSupabaseClient,
  token: string,
  email: string,
): Promise<InvitedAccount> {
  const { data, error } = await service
    .rpc("team_invited_account", {
      p_token_hash: hashTeamInviteToken(token),
      p_email: email,
    })
    .single();
  if (error) throw databaseException(error);
  const state = data.state as InvitationState | InvitedAccount["state"];
  if (state === "none") return { state };
  if (state === "unconfirmed" || state === "confirmed") {
    return { state, userId: data.user_id! };
  }
  throw refusal(state);
}

export type TeamSignUpResult = {
  status: "confirmation_required";
  email: string;
  next: null;
};

/**
 * Sign-up through a team invitation: her account is made by the server with
 * her password, only for the invited address, and a confirmation link for
 * this device lands on /equipe/invitation, where she joins
 * (acceptTeamInviteAction). An account that exists, unconfirmed, is never
 * changed (anyone may have made it): a recovery link is sent instead, and she
 * sets her own password there (completeTeamInviteAction). Confirmed:
 * `email_taken` (she signs in with her invitation).
 */
export async function signUpThroughTeamInvite(
  service: AppSupabaseClient,
  client: AppSupabaseClient,
  token: string,
  account: Pick<SignUpInput, "email" | "password" | "firstName" | "lastName">,
): Promise<TeamSignUpResult> {
  const existing = await teamInvitedAccount(service, token, account.email);
  const callback = authCallbackUrl(
    getPublicEnv().NEXT_PUBLIC_APP_URL,
    TEAM_INVITATION_PAGE,
  );
  const answer = {
    status: "confirmation_required" as const,
    email: account.email,
    next: null,
  };
  if (existing.state === "confirmed") throw new AppException("email_taken");
  if (existing.state === "unconfirmed") {
    await rememberTeamInvitation(token);
    await sendRecovery(client, account.email, callback);
    return answer;
  }

  const created = await service.auth.admin.createUser({
    email: account.email,
    password: account.password,
    email_confirm: false,
    user_metadata: {
      first_name: account.firstName ?? null,
      last_name: account.lastName ?? null,
    },
  });
  if (created.error) {
    // Made meanwhile by someone else: the same answer as above, nothing given.
    if (created.error.code !== "email_exists")
      throw authException(created.error);
    await rememberTeamInvitation(token);
    await sendRecovery(client, account.email, callback);
    return answer;
  }
  const { data, error } = await service.rpc("record_team_invitation_signup", {
    p_token_hash: hashTeamInviteToken(token),
    p_email: account.email,
    p_user_id: created.data.user.id,
  });
  if (error) throw databaseException(error);
  if (data !== "valid") throw refusal(data);

  await rememberTeamInvitation(token);
  await sendConfirmation(client, account.email, callback);
  return answer;
}

/**
 * The signed-in person joins: her other sessions end first (whoever else
 * held one loses it before anything is given), then her session accepts.
 * Throws `invitation_password_required` for a session that did not prove
 * her password (a recovery link: completeTeamInviteAction).
 */
export async function joinTeam(
  client: AppSupabaseClient,
  token: string,
): Promise<string> {
  const { data } = await client.auth.getUser();
  const user = data.user;
  if (!user) throw new AppException("unauthenticated");
  if (!user.email || !user.email_confirmed_at) {
    throw new AppException("invitation_email_mismatch");
  }
  await currentSessionId(client, user.id);
  // A wrong link ends nothing: the invitation is checked first (again,
  // under its lock, by accept_team_invitation).
  const account = await teamInvitedAccount(
    createAdminSupabaseClient() as AppSupabaseClient,
    token,
    user.email,
  );
  if (account.state === "none" || account.userId !== user.id) {
    throw new AppException("invitation_invalid");
  }
  await endOtherSessions(client);
  const accepted = await client.rpc("accept_team_invitation", {
    p_token_hash: hashTeamInviteToken(token),
  });
  if (accepted.error) throw databaseException(accepted.error);
  return accepted.data;
}

/** Sign-in with a team invitation: `accepted`, or why not (she stays signed in). */
export async function joinTeamOnSignIn(
  client: AppSupabaseClient,
  token: string,
): Promise<string> {
  try {
    await joinTeam(client, token);
    return "accepted";
  } catch (error) {
    if (error instanceof AppException && error.code !== "internal") {
      if (error.code === "session_revocation_failed") throw error;
      return error.code;
    }
    throw error;
  }
}

/**
 * After her recovery link (`sessionId`, its proof, checked by the caller)
 * and her own password set: her other sessions are ended by the caller,
 * then the server accepts for her.
 */
export async function acceptTeamInvitationFor(
  service: AppSupabaseClient,
  token: string,
  email: string,
  userId: string,
  sessionId: string,
): Promise<string> {
  const { data, error } = await service.rpc("accept_team_invitation_for", {
    p_token_hash: hashTeamInviteToken(token),
    p_email: email,
    p_user_id: userId,
    p_proof_session: sessionId,
  });
  if (error) throw databaseException(error);
  return data;
}
