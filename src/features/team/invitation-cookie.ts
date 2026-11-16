import "server-only";

import { cookies } from "next/headers";

import { TEAM_INVITE_TOKEN_PATTERN } from "@/features/team/schemas";

// Her team invitation, kept on her device while she confirms her address
// (sign-up through it) or proves her mailbox (a recovery link) and lands on
// /equipe/invitation. httpOnly: never readable by a page script. It is not
// a proof of anything: her session is (accept_team_invitation).

const TEAM_INVITATION_COOKIE = "team_invitation";

/** Auth's links last an hour (otp_expiry); a margin. */
const TEAM_INVITATION_COOKIE_MAX_AGE = 2 * 60 * 60;

export async function rememberTeamInvitation(token: string): Promise<void> {
  const store = await cookies();
  store.set(TEAM_INVITATION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TEAM_INVITATION_COOKIE_MAX_AGE,
  });
}

export async function rememberedTeamInvitation(): Promise<string | undefined> {
  const value = (await cookies()).get(TEAM_INVITATION_COOKIE)?.value;
  return value && TEAM_INVITE_TOKEN_PATTERN.test(value) ? value : undefined;
}

export async function forgetTeamInvitation(): Promise<void> {
  (await cookies()).delete(TEAM_INVITATION_COOKIE);
}
