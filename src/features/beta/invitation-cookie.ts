import "server-only";

import { cookies } from "next/headers";

import { INVITATION_TOKEN_PATTERN } from "@/features/beta/token";

// Her invitation, kept on her device while she proves her mailbox is hers
// (a recovery link, for an account made before her invitation) and sets her
// password (/invitation). httpOnly: never readable by a page script. It is
// not a proof of anything: the recovery session is (completeInvitationAction).

const INVITATION_COOKIE = "beta_invitation";

/** The recovery link lasts an hour (Auth's otp_expiry); a margin. */
const INVITATION_COOKIE_MAX_AGE = 2 * 60 * 60;

export async function rememberInvitation(token: string): Promise<void> {
  const store = await cookies();
  store.set(INVITATION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: INVITATION_COOKIE_MAX_AGE,
  });
}

export async function rememberedInvitation(): Promise<string | undefined> {
  const value = (await cookies()).get(INVITATION_COOKIE)?.value;
  return value && INVITATION_TOKEN_PATTERN.test(value) ? value : undefined;
}

export async function forgetInvitation(): Promise<void> {
  (await cookies()).delete(INVITATION_COOKIE);
}
