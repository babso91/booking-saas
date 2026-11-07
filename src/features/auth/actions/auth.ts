"use server";

import { revalidatePath } from "next/cache";

import {
  sendConfirmation,
  sendRecovery,
  signInWithPassword,
  signOut,
  type SignUpOutcome,
} from "@/features/auth/data/credentials";
import { authException } from "@/features/auth/data/auth-errors";
import {
  destinationFor,
  getSessionState,
  type SessionDestination,
  type SessionState,
} from "@/features/auth/data/session";
import { authCallbackUrl } from "@/features/auth/data/redirects";
import {
  acceptInvitationFor,
  assertInvitation,
  hasBetaAccess,
  invitedAccount,
} from "@/features/beta/invitations";
import {
  forgetInvitation,
  rememberInvitation,
  rememberedInvitation,
} from "@/features/beta/invitation-cookie";
import {
  completeInvitationSchema,
  signInSchema,
  signUpSchema,
} from "@/features/auth/schemas/auth";
import { getPublicEnv } from "@/lib/env/public";
import {
  AppException,
  toAppError,
  validationException,
  type ActionResult,
} from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  createServerSupabaseClient,
  forgetSessionOnThisDevice,
} from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Auth contract for the UI. Every action returns ActionResult<T> with stable
// error codes (see docs/AUTH_ONBOARDING_CONTRACT.md); none throws to the UI.

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Auth action failed", error);
    }

    return { ok: false, error: toAppError(error) };
  }
}

export type SignUpResult = SignUpOutcome & { next: SessionDestination | null };

/**
 * Creates an account, for an invited address only (private beta,
 * docs/BETA_ACCESS.md): `invitationToken` must be a valid invitation for
 * `email` (`beta_invitation_required`, `invitation_invalid`,
 * `invitation_expired`, `invitation_used`, `invitation_email_mismatch`
 * otherwise; nothing is created). Her account is made by the server, with
 * her password, and a link to confirm her address is sent (the proof that
 * the mailbox is hers); her access counts once she follows it. An account
 * made before by anyone, not confirmed, is never changed here (its password
 * may be a third party's): a recovery link is sent to her address instead,
 * and her invitation kept on this device; following it, she sets her own
 * password on /invitation (completeInvitationAction), which accepts it. A
 * confirmed one answers `email_taken` (she signs in with her invitation).
 * Otherwise the answer is always `status: "confirmation_required"`.
 */
export async function signUpAction(
  input: unknown,
): Promise<ActionResult<SignUpResult>> {
  return run(async () => {
    const parsed = signUpSchema.safeParse(input);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    // The invitation first: no account is created without one.
    const service = createAdminSupabaseClient() as AppSupabaseClient;
    const { invitationToken, ...account } = parsed.data;
    await assertInvitation(service, invitationToken, account.email);

    const client = await createServerSupabaseClient();
    // Her account is made by the server, at once and only if none exists
    // (a public sign-up would keep the password of an account a third
    // party made first: Auth keeps the first password).
    const created = await service.auth.admin.createUser({
      email: account.email,
      password: account.password,
      email_confirm: false,
      user_metadata: {
        first_name: account.firstName ?? null,
        last_name: account.lastName ?? null,
      },
    });
    const userId = created.data.user?.id;
    if (created.error) {
      if (created.error.code !== "email_exists")
        throw authException(created.error);
      const existing = await invitedAccount(
        service,
        invitationToken,
        account.email,
      );
      // Confirmed already: its password is not proven here; she signs in
      // with her invitation (signInAction). Nothing is given.
      if (existing.state !== "unconfirmed")
        throw new AppException("email_taken");
      // Not confirmed: anyone may have made it, with any password, and it
      // may be confirmed at any moment. Nothing of it is changed nor given
      // here: the invitation is no proof that the account is hers. She
      // proves the mailbox is hers with a recovery link (for this device),
      // then chooses her password (completeInvitationAction).
      await rememberInvitation(invitationToken!);
      await sendRecovery(
        client,
        account.email,
        authCallbackUrl(getPublicEnv().NEXT_PUBLIC_APP_URL, "/invitation"),
      );
      return {
        status: "confirmation_required" as const,
        email: account.email,
        next: null,
      };
    }
    await acceptInvitationFor(service, invitationToken, account.email, userId!);

    // The proof that the mailbox is hers: a confirmation link for this
    // device (PKCE). Her access counts once she follows it.
    await sendConfirmation(
      client,
      account.email,
      authCallbackUrl(getPublicEnv().NEXT_PUBLIC_APP_URL),
    );
    return {
      status: "confirmation_required" as const,
      email: account.email,
      next: null,
    };
  });
}

/**
 * Signs in and tells the UI where to go: "/onboarding" or "/app". With
 * `invitationToken` (her account existed before her invitation): once her
 * password is proven on her confirmed account, every other session of the
 * account is ended, then the invitation is accepted for this session;
 * `invitation` says what happened (`accepted`, or why not). If the other
 * sessions cannot be ended, nothing is given and the action fails with
 * `session_revocation_failed` (she stays signed in; signing in again
 * retries).
 */
export async function signInAction(
  input: unknown,
): Promise<ActionResult<{ next: SessionDestination; invitation?: string }>> {
  return run(async () => {
    const parsed = signInSchema.safeParse(input);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const { invitationToken, ...credentials } = parsed.data;
    const client = await createServerSupabaseClient();
    await signInWithPassword(client, credentials);

    let invitation: string | undefined;
    if (invitationToken) {
      invitation = await acceptOnSignIn(client, invitationToken);
    }
    const state = await getSessionState(client);

    revalidatePath("/", "layout");
    return invitation
      ? { next: destinationFor(state), invitation }
      : { next: destinationFor(state) };
  });
}

/**
 * The session of this request's own JWT (its `session_id` claim), verified,
 * for the signed-in `userId`.
 */
async function currentSessionId(
  client: AppSupabaseClient,
  userId: string,
): Promise<{
  sessionId: string;
  amr: { method: string; timestamp: number }[];
}> {
  const { data, error } = await client.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || claims.sub !== userId || !claims.session_id) {
    throw new AppException("unauthenticated");
  }
  const amr = (claims.amr ?? []).flatMap((entry) =>
    typeof entry === "string" ? [] : [entry],
  );
  return { sessionId: claims.session_id as string, amr };
}

async function acceptOnSignIn(
  client: AppSupabaseClient,
  invitationToken: string,
): Promise<string> {
  const { data } = await client.auth.getUser();
  const user = data.user;
  if (!user?.email || !user.email_confirmed_at) return "invitation_invalid";
  const { sessionId } = await currentSessionId(client, user.id);
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  try {
    const account = await invitedAccount(service, invitationToken, user.email);
    if (account.state !== "confirmed" || account.userId !== user.id) {
      return "invitation_invalid";
    }
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  // Whoever else held a session of this account loses it, before anything
  // is given: if that fails, nothing is (the access is bound to this
  // session anyway, has_beta_access).
  await endOtherSessions(client);
  try {
    await acceptInvitationFor(
      service,
      invitationToken,
      user.email,
      user.id,
      sessionId,
    );
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return "accepted";
}

async function endOtherSessions(client: AppSupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut({ scope: "others" });
  if (error) {
    console.error("Other sessions not ended", error.code ?? error.status);
    throw new AppException("session_revocation_failed");
  }
}

/** A recovery link followed within this time is a proof of her mailbox. */
const RECOVERY_PROOF_MAX_AGE_SECONDS = 60 * 60;

/**
 * /invitation, after the recovery link of signUpAction (an account made
 * before her invitation, not confirmed): sets HER password, ends every
 * other session of the account, then accepts the invitation kept on this
 * device for this session. Requires the session opened by that link (its
 * `amr` says `recovery`: she holds the mailbox), within the hour; otherwise
 * `invitation_invalid` (she starts again from her invitation link), and
 * `beta_invitation_required` without an invitation on this device. Nothing
 * is given unless every step succeeds (`session_revocation_failed` if the
 * other sessions cannot be ended; retrying is safe).
 */
export async function completeInvitationAction(
  input: unknown,
): Promise<ActionResult<{ next: "/onboarding" }>> {
  return run(async () => {
    const parsed = completeInvitationSchema.safeParse(input);
    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const invitationToken = await rememberedInvitation();
    if (!invitationToken) throw new AppException("beta_invitation_required");

    const client = await createServerSupabaseClient();
    const { data } = await client.auth.getUser();
    const user = data.user;
    if (!user?.email) throw new AppException("unauthenticated");
    const { sessionId, amr } = await currentSessionId(client, user.id);
    const now = Math.floor(Date.now() / 1000);
    const provenMailbox = amr.some(
      (entry) =>
        entry.method === "recovery" &&
        now - entry.timestamp <= RECOVERY_PROOF_MAX_AGE_SECONDS,
    );
    if (!user.email_confirmed_at || !provenMailbox) {
      throw new AppException("invitation_invalid");
    }

    const service = createAdminSupabaseClient() as AppSupabaseClient;
    const account = await invitedAccount(service, invitationToken, user.email);
    if (account.state !== "confirmed" || account.userId !== user.id) {
      throw new AppException("invitation_invalid");
    }

    // Her password replaces whatever it was (a third party's, maybe). The
    // same one again (a retry after a failure below) is already hers.
    const updated = await client.auth.updateUser({
      password: parsed.data.password,
    });
    if (updated.error && updated.error.code !== "same_password") {
      throw authException(updated.error);
    }
    await endOtherSessions(client);
    await acceptInvitationFor(
      service,
      invitationToken,
      user.email,
      user.id,
      sessionId,
    );
    await forgetInvitation();

    revalidatePath("/", "layout");
    return { next: "/onboarding" as const };
  });
}

export async function signOutAction(): Promise<
  ActionResult<{ next: "/login" }>
> {
  return run(async () => {
    // She asked to leave: this device forgets her session whatever Auth
    // answers. If Auth cannot be reached, the session is not revoked on its
    // side (its refresh token stays usable until it is revoked or the
    // session reaches Auth's configured limits), but nothing of it is left
    // on this device.
    const client = await createServerSupabaseClient("sign_out");
    try {
      if ((await signOut(client)) === "unavailable") {
        console.warn("Sign-out: Auth unreachable, session forgotten locally");
      }
    } finally {
      await forgetSessionOnThisDevice();
    }

    revalidatePath("/", "layout");
    return { next: "/login" as const };
  });
}

export type OnboardingStatus =
  | { status: "unauthenticated"; next: "/login" }
  | {
      status: "onboarding_required";
      next: "/onboarding";
      user: { email: string | null; emailConfirmed: boolean };
      /**
       * false: her account has no beta access (no invitation accepted), so
       * creating her business is refused (`beta_invitation_required`).
       */
      betaAccess: boolean;
    }
  | {
      status: "ready";
      next: "/app";
      user: { email: string | null; emailConfirmed: boolean };
      business: { slug: string; name: string; timezone: string };
    };

function toOnboardingStatus(
  state: SessionState,
  betaAccess: boolean,
): OnboardingStatus {
  switch (state.status) {
    case "unauthenticated":
      return { status: "unauthenticated", next: "/login" };
    case "onboarding_required":
      return {
        status: "onboarding_required",
        next: "/onboarding",
        user: {
          email: state.user.email,
          emailConfirmed: state.user.emailConfirmed,
        },
        betaAccess,
      };
    case "ready":
      return {
        status: "ready",
        next: "/app",
        user: {
          email: state.user.email,
          emailConfirmed: state.user.emailConfirmed,
        },
        business: {
          slug: state.business.slug,
          name: state.business.name,
          timezone: state.business.timezone,
        },
      };
  }
}

export async function getOnboardingStatusAction(): Promise<
  ActionResult<OnboardingStatus>
> {
  return run(async () => {
    const client = await createServerSupabaseClient();
    const state = await getSessionState(client);
    return toOnboardingStatus(
      state,
      state.status === "onboarding_required"
        ? await hasBetaAccess(client)
        : true,
    );
  });
}
