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
import { signInSchema, signUpSchema } from "@/features/auth/schemas/auth";
import { getPublicEnv } from "@/lib/env/public";
import {
  AppException,
  toAppError,
  validationException,
  type ActionResult,
} from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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
 * Creates an account. `status: "signed_in"` → go to `next` ("/onboarding").
 * `status: "confirmation_required"` → show "check your inbox"; `next` is null.
 */
export async function signUpAction(
  input: unknown,
): Promise<ActionResult<SignUpResult>> {
  return run(async () => {
    const parsed = signUpSchema.safeParse(input);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const client = await createServerSupabaseClient();
    const outcome = await signUpWithPassword(
      client,
      parsed.data,
      new URL("/auth/callback", getPublicEnv().NEXT_PUBLIC_APP_URL).toString(),
    );

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
    const client = await createServerSupabaseClient();
    await signOut(client);

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
    }
  | {
      status: "ready";
      next: "/app";
      user: { email: string | null; emailConfirmed: boolean };
      business: { slug: string; name: string; timezone: string };
    };

function toOnboardingStatus(state: SessionState): OnboardingStatus {
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
    return toOnboardingStatus(await getSessionState(client));
  });
}
