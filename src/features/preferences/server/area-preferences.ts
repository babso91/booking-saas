import "server-only";

import { cookies } from "next/headers";

import {
  deviceCacheOwner,
  readMemberPreferences,
} from "@/features/preferences/data/preferences";
import {
  DEVICE_CACHE_COOKIE,
  LEGACY_APPEARANCE_COOKIE,
  parseDeviceCache,
  parseLegacyAppearanceCookie,
} from "@/features/preferences/device-cache";
import {
  defaultAppearancePreferences,
  noMemberPreferences,
  sameAppearance,
  type AppearancePreferences,
  type PreferencesSnapshot,
} from "@/features/preferences/model";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type AreaPreferences = {
  /**
   * Her preferences and their context (her membership), to render the area
   * and to start the device's sync state (initialSyncState). Null when the
   * account could not be read: render `preferences`, save nothing until a
   * read gives a context.
   */
  snapshot: PreferencesSnapshot | null;
  /** What to render now. */
  appearance: AppearancePreferences;
  /**
   * account: read from her account (the truth);
   * device:  the account could not be read, this device's cache of HER
   *          preferences is shown;
   * default: neither: the defaults.
   */
  source: "account" | "device" | "default";
  /**
   * The appearance this device had before accounts kept one (Studio 1's
   * cookie), offered for import while her account has none. Never applied
   * by itself.
   */
  deviceAppearanceOffer: AppearancePreferences | null;
};

/**
 * Her preferences for the first render of the area (the layout of /app,
 * after requireReadyBusiness: `userId` and `businessId` come from the
 * session). Never throws: an area without its appearance is still usable.
 */
export async function loadAreaPreferences(member: {
  userId: string;
  businessId: string;
}): Promise<AreaPreferences> {
  const cookieStore = await cookies();
  try {
    const client = await createServerSupabaseClient();
    const snapshot = await readMemberPreferences(
      client,
      member.userId,
      member.businessId,
    );
    const offer =
      snapshot.preferences.version === 0
        ? parseLegacyAppearanceCookie(
            cookieStore.get(LEGACY_APPEARANCE_COOKIE)?.value,
          )
        : null;
    return {
      snapshot,
      appearance: snapshot.preferences.appearance,
      source: "account",
      deviceAppearanceOffer:
        offer && !sameAppearance(offer, defaultAppearancePreferences)
          ? offer
          : null,
    };
  } catch (error) {
    console.error("Member preferences unavailable", error);
    const cached = parseDeviceCache(
      cookieStore.get(DEVICE_CACHE_COOKIE)?.value,
      deviceCacheOwner(member.userId, member.businessId),
    );
    return {
      snapshot: null,
      appearance: (cached?.preferences ?? noMemberPreferences).appearance,
      source: cached ? "device" : "default",
      deviceAppearanceOffer: null,
    };
  }
}
