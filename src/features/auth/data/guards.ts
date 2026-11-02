import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import {
  destinationFor,
  getSessionState,
  type SessionState,
} from "@/features/auth/data/session";
import { AppException } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Session state of the current request, computed once per render pass. */
export const currentSessionState = cache(async (): Promise<SessionState> => {
  const client = await createServerSupabaseClient();
  return getSessionState(client);
});

// Each guard redirects to the one route that accepts the current state, so
// no state can bounce between two routes:
//   unauthenticated     → /login       (accepts unauthenticated)
//   onboarding_required → /onboarding  (accepts onboarding_required)
//   ready               → /app         (accepts ready)
// Auth unreachable is none of them: it is a temporary error, shown on
// /indisponible (no guard, no session needed). Nothing is let through, and
// nothing signs her out.

export const AUTH_UNAVAILABLE_PATH = "/indisponible";

async function guardedSessionState() {
  try {
    return await currentSessionState();
  } catch (error) {
    if (error instanceof AppException && error.code === "auth_unavailable") {
      redirect(AUTH_UNAVAILABLE_PATH);
    }
    throw error;
  }
}

/** For /app: signed in with a business, otherwise redirected. */
export async function requireReadyBusiness() {
  const state = await guardedSessionState();

  if (state.status !== "ready") {
    redirect(destinationFor(state));
  }

  return state;
}

/** For /onboarding: signed in without a business, otherwise redirected. */
export async function requirePendingOnboarding() {
  const state = await guardedSessionState();

  if (state.status !== "onboarding_required") {
    redirect(destinationFor(state));
  }

  return state;
}

/** For /login and sign-up pages: signed-in users are sent onwards. */
export async function redirectAuthenticatedUser() {
  const state = await guardedSessionState();

  if (state.status !== "unauthenticated") {
    redirect(destinationFor(state));
  }
}
