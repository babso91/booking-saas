import "server-only";

import { cookies } from "next/headers";

import { currentSessionState } from "@/features/auth/data/guards";
import type { SessionState } from "@/features/auth/data/session";
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
  sameContext,
  type AppearancePreferences,
  type PreferenceContext,
  type PreferencesSnapshot,
} from "@/features/preferences/model";
import { AppException } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Why the page's identity could not be confirmed:
 *   unauthenticated      no valid session;
 *   onboarding_required  signed in, without a business;
 *   auth_unavailable     Supabase Auth could not be reached;
 *   session_unreadable   her membership could not be read;
 *   membership_changed   her membership changed during this render (she
 *                        left, and maybe joined again): neither the old one
 *                        nor a new one is vouched for.
 */
export type UnconfirmedReason =
  | Exclude<SessionState["status"], "ready">
  | "auth_unavailable"
  | "session_unreadable"
  | "membership_changed";

/**
 * Who the page is for, from the session (Auth, then her membership read
 * under RLS), never from a snapshot, a cookie or the device.
 */
export type AreaIdentity =
  | { status: "confirmed"; context: PreferenceContext }
  | { status: "unconfirmed"; reason: UnconfirmedReason };

type Shown = {
  /** What to render now. */
  appearance: AppearancePreferences;
  /**
   * The appearance this device had before accounts kept one (Studio 1's
   * cookie), offered for import while her account has none. Never applied
   * by itself.
   */
  deviceAppearanceOffer: AppearancePreferences | null;
};

export type AreaPreferences =
  | (Shown & {
      identity: { status: "confirmed"; context: PreferenceContext };
      /**
       * Her preferences, for exactly `identity.context` (checked), to start
       * the device's sync state. Null when they could not be read: the
       * identity still holds; nothing is saved until a read for this
       * identity answers.
       */
      snapshot: PreferencesSnapshot | null;
      /**
       * account: read from her account (the truth), `snapshot` set;
       * device:  not read; this device's cache for this very membership;
       * default: not read, and no such cache: the defaults.
       */
      source: "account" | "device" | "default";
    })
  | (Shown & {
      identity: { status: "unconfirmed"; reason: UnconfirmedReason };
      /** Never a snapshot, never a cache: no context is vouched for. */
      snapshot: null;
      source: "default";
    });

function unconfirmed(reason: UnconfirmedReason): AreaPreferences {
  return {
    identity: { status: "unconfirmed", reason },
    snapshot: null,
    appearance: defaultAppearancePreferences,
    source: "default",
    deviceAppearanceOffer: null,
  };
}

/**
 * Her preferences for the first render of the area (the layout of /app,
 * after requireReadyBusiness). The identity comes from the session state of
 * this request (the one the guard used), not from the caller and not from
 * the preferences read: it is given even when they cannot be read, and the
 * snapshot is only ever for it. Never throws: an area without its appearance
 * is still usable.
 */
export async function loadAreaPreferences(): Promise<AreaPreferences> {
  let state: SessionState;
  try {
    state = await currentSessionState();
  } catch (error) {
    return unconfirmed(
      error instanceof AppException && error.code === "auth_unavailable"
        ? "auth_unavailable"
        : "session_unreadable",
    );
  }
  if (state.status !== "ready") return unconfirmed(state.status);

  const context: PreferenceContext = {
    userId: state.user.id,
    businessId: state.business.id,
    membershipId: state.business.membershipId,
  };
  const cookieStore = await cookies();

  let snapshot: PreferencesSnapshot;
  try {
    const client = await createServerSupabaseClient();
    snapshot = await readMemberPreferences(
      client,
      context.userId,
      context.businessId,
    );
  } catch (error) {
    // Refused, not failed: the session no longer holds this membership (she
    // left, or her session ended, after the guard read it). Nothing is
    // vouched for any more.
    if (error instanceof AppException && error.code === "forbidden") {
      return unconfirmed("membership_changed");
    }
    if (error instanceof AppException && error.code === "unauthenticated") {
      return unconfirmed("unauthenticated");
    }
    console.error("Member preferences unavailable", error);
    const cached = parseDeviceCache(
      cookieStore.get(DEVICE_CACHE_COOKIE)?.value,
      deviceCacheOwner(context.userId, context.businessId),
    );
    // Only the cache of this very membership: not one she had before
    // leaving and joining again.
    const usable =
      cached && cached.membershipId === context.membershipId ? cached : null;
    return {
      identity: { status: "confirmed", context },
      snapshot: null,
      appearance: (usable?.preferences ?? noMemberPreferences).appearance,
      source: usable ? "device" : "default",
      deviceAppearanceOffer: null,
    };
  }

  if (!sameContext(snapshot.context, context)) {
    return unconfirmed("membership_changed");
  }

  const offer =
    snapshot.preferences.version === 0
      ? parseLegacyAppearanceCookie(
          cookieStore.get(LEGACY_APPEARANCE_COOKIE)?.value,
        )
      : null;
  return {
    identity: { status: "confirmed", context },
    snapshot,
    appearance: snapshot.preferences.appearance,
    source: "account",
    deviceAppearanceOffer:
      offer && !sameAppearance(offer, defaultAppearancePreferences)
        ? offer
        : null,
  };
}
