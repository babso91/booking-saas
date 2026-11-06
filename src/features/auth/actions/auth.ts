"use server";

import { revalidatePath } from "next/cache";

import {
  signInWithPassword,
  signOut,
  signUpWithPassword,
  type SignUpOutcome,
} from "@/features/auth/data/credentials";
import {
  destinationFor,
  getSessionState,
  type SessionDestination,
  type SessionState,
} from "@/features/auth/data/session";
import { authCallbackUrl } from "@/features/auth/data/redirects";
import {
  acceptInvitation,
  acceptInvitationIfAccount,
  assertInvitation,
  hasBetaAccess,
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
 * otherwise; nothing is created). `status: "signed_in"` → go to `next`
 * ("/onboarding"). `status: "confirmation_required"` → show "check your
 * inbox"; `next` is null.
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
    let outcome: SignUpOutcome;
    try {
      outcome = await signUpWithPassword(
        client,
        account,
        authCallbackUrl(getPublicEnv().NEXT_PUBLIC_APP_URL),
      );
    } catch (error) {
      // Auth refused (an account already there: a first attempt interrupted
      // after Auth created it, or one made before her invitation; a retry
      // too soon; a simultaneous attempt). If the invited address has an
      // account, it gets its access all the same (found by the database,
      // never taken from the caller); then Auth's answer is hers.
      await acceptInvitationIfAccount(service, invitationToken, account.email);
      throw error;
    }
    // Accepted for the account of the invited address, once (idempotent: a
    // retry of this same sign-up answers the same).
    await acceptInvitation(service, invitationToken, account.email);

    if (outcome.status === "confirmation_required") {
      return { ...outcome, next: null };
    }

    revalidatePath("/", "layout");
    return { ...outcome, next: "/onboarding" };
  });
}

/** Signs in and tells the UI where to go: "/onboarding" or "/app". */
export async function signInAction(
  input: unknown,
): Promise<ActionResult<{ next: SessionDestination }>> {
  return run(async () => {
    const parsed = signInSchema.safeParse(input);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const client = await createServerSupabaseClient();
    await signInWithPassword(client, parsed.data);
    const state = await getSessionState(client);

    revalidatePath("/", "layout");
    return { next: destinationFor(state) };
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
