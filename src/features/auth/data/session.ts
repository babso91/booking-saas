import "server-only";

import { AppException } from "@/lib/errors";
import { authFailureOf } from "@/lib/supabase/auth-errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type SessionUser = {
  id: string;
  email: string | null;
  emailConfirmed: boolean;
};

export type OnboardedBusiness = {
  id: string;
  /**
   * Her membership in it (business_members.id): a new one if she left and
   * joined again. With the user id and the business id, the identity her
   * preferences are synchronised for (PreferenceContext).
   */
  membershipId: string;
  slug: string;
  name: string;
  timezone: string;
};

/**
 * Server-side state of the current visitor. Derived from the Supabase Auth
 * server (getUser validates the session, it does not trust the cookie alone)
 * and from business_members read under RLS. Never from client state.
 * Auth unreachable is not "unauthenticated": getSessionState throws
 * AppException("auth_unavailable") instead (src/lib/supabase/auth-errors.ts).
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

  if (error && authFailureOf(error) === "unavailable") {
    throw new AppException("auth_unavailable", { cause: error });
  }
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
    .select("id, business_id, businesses!inner(slug, name, timezone)")
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
      membershipId: membership.id,
      slug: membership.businesses.slug,
      name: membership.businesses.name,
      timezone: membership.businesses.timezone,
    },
  };
}
