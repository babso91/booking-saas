import {
  APPEARANCE_COOKIE,
  defaultAppearance,
  parseAppearance,
  serializeAppearance,
  type Appearance,
} from "@/features/appearance/appearance";

/**
 * What the discovery keeps, before any account exists.
 *
 * - While she explores: a draft in this browser (localStorage), so a
 *   reload, a back button or a closed tab finds her salon's name and her
 *   universe again. Nothing leaves the device.
 * - When she chooses: the device's appearance cookie (`dash_appearance`,
 *   Path=/app), the one the professional area already knows. An account
 *   that never saved a preference is offered that look on arrival
 *   (features/preferences/server/area-preferences.ts); a marker says it was
 *   chosen in the discovery, so it is applied without asking again
 *   (AccountAppearanceProvider). An account that already has preferences
 *   is never changed by it.
 *
 * Only the PROFESSIONAL software's look is kept here; her clients' mini-site
 * is chosen on its own, in « Mon site ».
 */

const DRAFT_KEY = "booking:discovery";
/** A choice older than this is not applied any more. */
const KEPT_DAYS = 30;
export const DISCOVERY_MARKER_COOKIE = "dash_appearance_origin";
export const DISCOVERY_MARKER = "discovery";

export type DiscoveryDraft = {
  businessName: string;
  appearance: Appearance;
  /** Set once she chose: her universe is kept for her account. */
  chosen: boolean;
  savedAt: number;
};

export const emptyDraft = (): DiscoveryDraft => ({
  businessName: "",
  appearance: { ...defaultAppearance },
  chosen: false,
  savedAt: Date.now(),
});

export function readDraft(): DiscoveryDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DiscoveryDraft>;
    if (typeof value !== "object" || value === null) return null;
    if (
      typeof value.savedAt !== "number" ||
      Date.now() - value.savedAt > KEPT_DAYS * 86_400_000
    )
      return null;
    return {
      businessName:
        typeof value.businessName === "string"
          ? value.businessName.slice(0, 80)
          : "",
      // Re-read through the cookie format: only known values survive.
      appearance: parseAppearance(
        value.appearance ? serializeAppearance(value.appearance) : undefined,
      ),
      chosen: value.chosen === true,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

export function writeDraft(draft: DiscoveryDraft) {
  try {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ ...draft, savedAt: Date.now() }),
    );
  } catch {
    // Private mode or storage refused: the discovery still works, only a
    // reload starts it again.
  }
}

/** Her choice, for the account she is about to create. */
export function keepForAccount(appearance: Appearance) {
  const maxAge = KEPT_DAYS * 86_400;
  document.cookie = `${APPEARANCE_COOKIE}=${serializeAppearance(appearance)}; Path=/app; Max-Age=${maxAge}; SameSite=Lax`;
  document.cookie = `${DISCOVERY_MARKER_COOKIE}=${DISCOVERY_MARKER}; Path=/app; Max-Age=${maxAge}; SameSite=Lax`;
}

/** She went back to exploring: nothing is kept for an account. */
export function forgetForAccount() {
  document.cookie = `${APPEARANCE_COOKIE}=; Path=/app; Max-Age=0; SameSite=Lax`;
  document.cookie = `${DISCOVERY_MARKER_COOKIE}=; Path=/app; Max-Age=0; SameSite=Lax`;
}
