import "server-only";

import { authException } from "@/features/auth/data/auth-errors";
import type { SignInInput, SignUpInput } from "@/features/auth/schemas/auth";
import { authFailureOf } from "@/lib/supabase/auth-errors";
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

  // With confirmation enabled, no session is returned until the email is
  // confirmed. A still-unconfirmed address is answered like a new account
  // (the email is sent again); a confirmed one fails with user_already_exists
  // (email_taken) above.
  if (!data.session) {
    return { status: "confirmation_required", email: input.email };
  }

  return { status: "signed_in" };
}

/**
 * Sends (again) the sign-up confirmation link of an unconfirmed account,
 * for this device's PKCE flow: the link lands on `emailRedirectTo`.
 */
export async function sendConfirmation(
  client: AppSupabaseClient,
  email: string,
  emailRedirectTo: string,
): Promise<void> {
  const { error } = await client.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo },
  });
  if (error) {
    throw authException(error);
  }
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
 *   revoked      Auth ended the session (or it was already invalid);
 *   unavailable  Auth could not be reached: the session is not revoked on
 *                its side. The caller still forgets it on this device
 *                (forgetSessionOnThisDevice).
 */
export async function signOut(
  client: AppSupabaseClient,
): Promise<"revoked" | "unavailable"> {
  const { error } = await client.auth.signOut({ scope: "local" });

  if (error && authFailureOf(error) === "unavailable") {
    return "unavailable";
  }
  // An already-invalid session is a successful sign-out.
  if (error && error.code !== "session_not_found") {
    throw authException(error);
  }
  return "revoked";
}
