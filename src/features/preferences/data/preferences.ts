import "server-only";

import { createHash } from "node:crypto";

import {
  fromDatabaseRow,
  noMemberPreferences,
  toDatabaseChanges,
  type AppearanceChanges,
  type MemberPreferences,
} from "@/features/preferences/model";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// A professional's own preferences in the business resolved from her
// session (never a business sent by the browser). Every call is made with
// her client: RLS lets her read her own row only, and the save function
// writes for auth.uid() only. See docs/MEMBER_PREFERENCES_CONTRACT.md.

export type SavePreferencesResult = {
  /** saved: applied; unchanged: already so; stale: another device saved first. */
  status: "saved" | "unchanged" | "stale";
  /** The account's preferences now (whatever the status). */
  preferences: MemberPreferences;
};

/** Her preferences in businessId; version 0 and the defaults if none. */
export async function getMemberPreferences(
  client: AppSupabaseClient,
  businessId: string,
  userId: string,
): Promise<MemberPreferences> {
  const { data, error } = await client
    .from("member_preferences")
    .select("style, ambiance, color_mode, accent, motion, version")
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw databaseException(error);
  }

  return data ? fromDatabaseRow(data) : noMemberPreferences;
}

/** Saves the fields she changed, based on the version her device read. */
export async function saveMemberPreferences(
  client: AppSupabaseClient,
  businessId: string,
  expectedVersion: number,
  changes: AppearanceChanges,
): Promise<SavePreferencesResult> {
  const { data, error } = await client
    .rpc("save_member_preferences", {
      p_business_id: businessId,
      p_expected_version: expectedVersion,
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

  return { status: data.status, preferences: fromDatabaseRow(data) };
}

/**
 * The owner of a device cache: who it was written for. Not a secret and
 * never an authorisation (the account is read on every render); only so
 * that a device never shows one professional another's cached appearance.
 */
export function deviceCacheOwner(userId: string, businessId: string) {
  return createHash("sha256")
    .update(`member-preferences:${userId}:${businessId}`)
    .digest("hex")
    .slice(0, 32);
}
