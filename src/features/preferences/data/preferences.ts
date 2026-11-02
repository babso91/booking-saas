import "server-only";

import { createHash } from "node:crypto";

import {
  fromDatabaseRow,
  toDatabaseChanges,
  type AppearanceChanges,
  type MemberPreferences,
  type PreferenceContext,
  type PreferencesSnapshot,
} from "@/features/preferences/model";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// A professional's own preferences in the business resolved from her
// session (never a business sent by the browser). Every call is made with
// her client; both functions act for auth.uid() only, and answer for whom
// (her membership: the context). See docs/MEMBER_PREFERENCES_CONTRACT.md.

export type SavePreferencesResult = PreferencesSnapshot & {
  /** saved: applied; unchanged: already so; stale: not the state she read. */
  status: "saved" | "unchanged" | "stale";
};

/** Her preferences in businessId (the defaults, version 0, if none). */
export async function readMemberPreferences(
  client: AppSupabaseClient,
  userId: string,
  businessId: string,
): Promise<PreferencesSnapshot> {
  const { data, error } = await client
    .rpc("read_member_preferences", { p_business_id: businessId })
    .single();

  if (error) {
    throw databaseException(error);
  }

  return {
    context: { userId, businessId, membershipId: data.membership_id },
    preferences: fromDatabaseRow(data),
  };
}

/**
 * Saves the fields she changed, for the context her device synchronises
 * (`context_changed` if it is no longer hers), based on the state her
 * device read.
 */
export async function saveMemberPreferences(
  client: AppSupabaseClient,
  context: PreferenceContext,
  expected: Pick<MemberPreferences, "incarnation" | "version">,
  changes: AppearanceChanges,
): Promise<SavePreferencesResult> {
  const { data, error } = await client
    .rpc("save_member_preferences", {
      p_business_id: context.businessId,
      p_membership_id: context.membershipId,
      // The generated types do not know the argument may be null.
      p_expected_incarnation: expected.incarnation as string,
      p_expected_version: expected.version,
      p_changes: toDatabaseChanges(changes),
    })
    .single();

  if (error) {
    throw databaseException(error);
  }

  if (
    data.status !== "saved" &&
    data.status !== "unchanged" &&
    data.status !== "stale"
  ) {
    throw new AppException("internal");
  }

  return {
    status: data.status,
    context: { ...context, membershipId: data.membership_id },
    preferences: fromDatabaseRow(data),
  };
}

/**
 * The owner of a device cache: who it was written for (her user id and
 * business). Not a secret and never an authorisation (the account is read
 * on every render); only so that a device never shows one professional
 * another's cached appearance. The membership is kept in the cache itself.
 */
export function deviceCacheOwner(userId: string, businessId: string) {
  return createHash("sha256")
    .update(`member-preferences:${userId}:${businessId}`)
    .digest("hex")
    .slice(0, 32);
}
