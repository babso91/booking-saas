"use server";

import { cookies } from "next/headers";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  deviceCacheOwner,
  getMemberPreferences,
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
  type MemberPreferences,
} from "@/features/preferences/model";

// Her preferences, for the appearance engine (docs/MEMBER_PREFERENCES_CONTRACT.md).
// The business is the one her session resolves to (runBusinessAction);
// nothing sent by the browser chooses whose preferences are read or
// written. Each answer also refreshes this device's cache of them.

/**
 * One year; presentation only, for the professional area. Written only when
 * it changes: setting a cookie refreshes the route.
 */
async function rememberOnDevice(
  userId: string,
  businessId: string,
  preferences: MemberPreferences,
) {
  const cookieStore = await cookies();
  const value = serializeDeviceCache(
    deviceCacheOwner(userId, businessId),
    preferences,
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

/** Her preferences as her account holds them (version 0: none yet). */
export async function getMyPreferencesAction() {
  return runBusinessAction(
    z.undefined(),
    undefined,
    async ({ client, businessId, userId }) => {
      const preferences = await getMemberPreferences(
        client,
        businessId,
        userId,
      );
      await rememberOnDevice(userId, businessId, preferences);
      return preferences;
    },
  );
}

/**
 * Saves the fields she changed (`changes`), based on the version her device
 * read (`expectedVersion`). `stale`: another device saved first, nothing was
 * written; the answer carries the account's state to apply them on again.
 */
export async function saveMyPreferencesAction(input: unknown) {
  return runBusinessAction(
    savePreferencesSchema,
    input,
    async (
      { client, businessId, userId },
      data,
    ): Promise<SavePreferencesResult> => {
      const result = await saveMemberPreferences(
        client,
        businessId,
        data.expectedVersion,
        data.changes,
      );
      await rememberOnDevice(userId, businessId, result.preferences);
      return result;
    },
  );
}

/**
 * Keeps the appearance this device had before her account did (Studio 1's
 * cookie), once she has said so. Only while her account has no preferences
 * yet: `stale` if it has some (they are kept, nothing is written).
 */
export async function importDeviceAppearanceAction(input: unknown) {
  return runBusinessAction(
    importDeviceAppearanceSchema,
    input,
    async (
      { client, businessId, userId },
      data,
    ): Promise<SavePreferencesResult> => {
      const changes = changesBetween(
        defaultAppearancePreferences,
        data.appearance,
      );
      const result =
        Object.keys(changes).length === 0
          ? {
              status: "unchanged" as const,
              preferences: await getMemberPreferences(
                client,
                businessId,
                userId,
              ),
            }
          : await saveMemberPreferences(client, businessId, 0, changes);
      await rememberOnDevice(userId, businessId, result.preferences);
      return result;
    },
  );
}
