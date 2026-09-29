import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import {
  destinationFor,
  getSessionState,
  type SessionState,
} from "@/features/auth/data/session";
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

/** For /app: signed in with a business, otherwise redirected. */
export async function requireReadyBusiness() {
  const state = await currentSessionState();

  if (state.status !== "ready") {
    redirect(destinationFor(state));
  }

  return state;
}

/** For /onboarding: signed in without a business, otherwise redirected. */
export async function requirePendingOnboarding() {
  const state = await currentSessionState();

  if (state.status !== "onboarding_required") {
    redirect(destinationFor(state));
  }

  return state;
}

/** For /login and sign-up pages: signed-in users are sent onwards. */
export async function redirectAuthenticatedUser() {
  const state = await currentSessionState();

  if (state.status !== "unauthenticated") {
    redirect(destinationFor(state));
  }
}
