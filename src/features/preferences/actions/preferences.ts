"use server";

import { cookies } from "next/headers";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  deviceCacheOwner,
  readMemberPreferences,
  saveMemberPreferences,
  type SavePreferencesResult,
} from "@/features/preferences/data/preferences";
import {
  DEVICE_CACHE_COOKIE,
  serializeDeviceCache,
} from "@/features/preferences/device-cache";
import {
  changesBetween,
  defaultAppearancePreferences,
  importDeviceAppearanceSchema,
  savePreferencesSchema,
  type PreferencesSnapshot,
} from "@/features/preferences/model";
import { AppException } from "@/lib/errors";

// Her preferences, for the appearance engine (docs/MEMBER_PREFERENCES_CONTRACT.md).
// The business is the one her session resolves to (runBusinessAction);
// nothing sent by the browser chooses whose preferences are read or
// written. A write names the context the page synchronises (business and
// membership): if the session is no longer in it, nothing is written
// (`context_changed`). Every answer says which context it is for, and
// refreshes this device's cache of it.

/**
 * One year; presentation only, for the professional area. Written only when
 * it changes: setting a cookie refreshes the route.
 */
async function rememberOnDevice(snapshot: PreferencesSnapshot) {
  const cookieStore = await cookies();
  const value = serializeDeviceCache(
    deviceCacheOwner(snapshot.context.userId, snapshot.context.businessId),
    {
      membershipId: snapshot.context.membershipId,
      preferences: snapshot.preferences,
    },
  );
  if (cookieStore.get(DEVICE_CACHE_COOKIE)?.value === value) return;
  cookieStore.set(DEVICE_CACHE_COOKIE, value, {
    path: "/app",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** The page's context must be the session's business. */
function sameBusiness(sessionBusinessId: string, pageBusinessId: string) {
  if (sessionBusinessId !== pageBusinessId) {
    throw new AppException("context_changed");
  }
}

/** Her preferences as her account holds them, and for which context. */
export async function getMyPreferencesAction() {
  return runBusinessAction(
    z.undefined(),
    undefined,
    async ({ client, businessId, userId }): Promise<PreferencesSnapshot> => {
      const snapshot = await readMemberPreferences(client, userId, businessId);
      await rememberOnDevice(snapshot);
      return snapshot;
    },
  );
}

/**
 * Saves the fields she changed (`changes`), for the page's context
 * (`context`), based on the state her device read (`expected`). `stale`:
 * not that state any more, nothing was written; the answer carries the
 * account's state to apply them on again.
 */
export async function saveMyPreferencesAction(input: unknown) {
  return runBusinessAction(
    savePreferencesSchema,
    input,
    async (
      { client, businessId, userId },
      data,
    ): Promise<SavePreferencesResult> => {
      sameBusiness(businessId, data.context.businessId);
      const result = await saveMemberPreferences(
        client,
        { userId, businessId, membershipId: data.context.membershipId },
        data.expected,
        data.changes,
      );
      await rememberOnDevice(result);
      return result;
    },
  );
}

/**
 * Keeps the appearance this device had before her account did (Studio 1's
 * cookie), once she has said so. Only while her account has no preferences
 * (no row): `stale` otherwise (they are kept, nothing is written).
 */
export async function importDeviceAppearanceAction(input: unknown) {
  return runBusinessAction(
    importDeviceAppearanceSchema,
    input,
    async (
      { client, businessId, userId },
      data,
    ): Promise<SavePreferencesResult> => {
      sameBusiness(businessId, data.context.businessId);
      const context = {
        userId,
        businessId,
        membershipId: data.context.membershipId,
      };
      const changes = changesBetween(
        defaultAppearancePreferences,
        data.appearance,
      );
      if (Object.keys(changes).length === 0) {
        const snapshot = await readMemberPreferences(
          client,
          userId,
          businessId,
        );
        if (snapshot.context.membershipId !== context.membershipId) {
          throw new AppException("context_changed");
        }
        await rememberOnDevice(snapshot);
        return { status: "unchanged", ...snapshot };
      }
      const result = await saveMemberPreferences(
        client,
        context,
        { incarnation: null, version: 0 },
        changes,
      );
      await rememberOnDevice(result);
      return result;
    },
  );
}
