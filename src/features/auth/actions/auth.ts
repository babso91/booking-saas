"use server";

import { revalidatePath } from "next/cache";

import {
  sendConfirmation,
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
  secureUnconfirmedAccount,
} from "@/features/beta/invitations";
import { signInSchema, signUpSchema } from "@/features/auth/schemas/auth";
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
 * her password; one made before by anyone, not confirmed, is made hers
 * (her password, its sessions dropped); a confirmed one answers
 * `email_taken` (she signs in with her invitation). The answer is always
 * `status: "confirmation_required"`: a link to confirm her address is sent
 * (the proof that the mailbox is hers); her access counts once she does.
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
    let userId = created.data.user?.id;
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
      // Not confirmed: anyone may have made it. It gets HER password and
      // her names, and drops every session (secureUnconfirmedAccount).
      userId = existing.userId;
      await secureUnconfirmedAccount(service, invitationToken, account.email, {
        userId,
        password: account.password,
        firstName: account.firstName,
        lastName: account.lastName,
      });
    } else {
      await acceptInvitationFor(
        service,
        invitationToken,
        account.email,
        userId!,
      );
    }

    // The proof that the mailbox is hers: a confirmation link, sent now
    // (setting a password voids an earlier one), for this device (PKCE).
    // Her access counts once she follows it.
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
 * password is proven on her confirmed account, the invitation is accepted
 * for it and every other session of the account is ended; `invitation`
 * says what happened (`accepted`, or why not).
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

async function acceptOnSignIn(
  client: AppSupabaseClient,
  invitationToken: string,
): Promise<string> {
  const { data } = await client.auth.getUser();
  const user = data.user;
  if (!user?.email || !user.email_confirmed_at) return "invitation_invalid";
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  try {
    await acceptInvitationFor(service, invitationToken, user.email, user.id);
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  // Whoever else held a session of this account loses it.
  const { error } = await client.auth.signOut({ scope: "others" });
  if (error) console.error("Other sessions not ended", error.code);
  return "accepted";
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
