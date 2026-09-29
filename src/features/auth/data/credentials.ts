import "server-only";

import { authException } from "@/features/auth/data/auth-errors";
import type { SignInInput, SignUpInput } from "@/features/auth/schemas/auth";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type SignUpOutcome =
  /** A session exists: continue to onboarding. */
  | { status: "signed_in" }
  /** Email confirmation is enabled: tell the user to check their inbox. */
  | { status: "confirmation_required"; email: string };

/**
 * Email + password sign-up through Supabase Auth. Works whether email
 * confirmation is enabled or not: the presence of a session decides.
 */
export async function signUpWithPassword(
  client: AppSupabaseClient,
  input: Pick<SignUpInput, "email" | "password"> &
    Partial<Pick<SignUpInput, "firstName" | "lastName">>,
  emailRedirectTo: string,
): Promise<SignUpOutcome> {
  const { data, error } = await client.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo,
      // Copied into public.profiles by the handle_new_user trigger.
      data: { first_name: input.firstName, last_name: input.lastName },
    },
  });

  if (error) {
    throw authException(error);
  }

  // With confirmation enabled, Supabase answers an already-registered email
  // with a user without identities and no session (anti-enumeration): the
  // response is deliberately the same as for a new account.
  if (!data.session) {
    return { status: "confirmation_required", email: input.email };
  }

  return { status: "signed_in" };
}

export async function signInWithPassword(
  client: AppSupabaseClient,
  input: SignInInput,
): Promise<void> {
  const { error } = await client.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (error) {
    throw authException(error);
  }
}

/**
 * Revokes the session server-side (refresh token and session row) and clears
 * the auth cookies. Scope "local" ends this device's session only.
 */
export async function signOut(client: AppSupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut({ scope: "local" });

  // An already-invalid session is a successful sign-out.
  if (error && error.code !== "session_not_found") {
    throw authException(error);
  }
}
