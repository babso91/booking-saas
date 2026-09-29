import "server-only";

import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type SessionUser = {
  id: string;
  email: string | null;
  emailConfirmed: boolean;
};

export type OnboardedBusiness = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
};

/**
 * Server-side state of the current visitor. Derived from the Supabase Auth
 * server (getUser validates the session, it does not trust the cookie alone)
 * and from business_members read under RLS. Never from client state.
 */
export type SessionState =
  | { status: "unauthenticated" }
  | { status: "onboarding_required"; user: SessionUser }
  | { status: "ready"; user: SessionUser; business: OnboardedBusiness };

export type SessionDestination = "/login" | "/onboarding" | "/app";

export function destinationFor(state: SessionState): SessionDestination {
  switch (state.status) {
    case "unauthenticated":
      return "/login";
    case "onboarding_required":
      return "/onboarding";
    case "ready":
      return "/app";
  }
}

export async function getSessionState(
  client: AppSupabaseClient,
): Promise<SessionState> {
  const { data, error } = await client.auth.getUser();

  if (error || !data.user) {
    return { status: "unauthenticated" };
  }

  const user: SessionUser = {
    id: data.user.id,
    email: data.user.email ?? null,
    emailConfirmed: Boolean(data.user.email_confirmed_at),
  };

  const { data: membership, error: membershipError } = await client
    .from("business_members")
    .select("business_id, businesses!inner(slug, name, timezone)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    throw databaseException(membershipError);
  }

  if (!membership) {
    return { status: "onboarding_required", user };
  }

  return {
    status: "ready",
    user,
    business: {
      id: membership.business_id,
      slug: membership.businesses.slug,
      name: membership.businesses.name,
      timezone: membership.businesses.timezone,
    },
  };
}
