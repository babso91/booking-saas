import {
  accentSchema,
  preferenceAmbiances,
  preferenceModes,
  preferenceMotions,
  preferenceStyles,
  type AppearancePreferences,
  type MemberPreferences,
} from "./model";

// What a device remembers of her preferences. Never an authority: the
// account (public.member_preferences) is the source of truth, read on every
// render of the area. The device only helps when the account cannot be
// read (database away), and only for the account that wrote it.
//
// `dash_pref`: written by the server after each read or save of her
// preferences (HttpOnly, Path=/app), and bound to its owner: the hash of
// her user id and business id. A cookie left on the device by another
// professional, or by her in another business, is ignored.
//
// `dash_appearance` (Studio 1, before this PR): the device's own choice, not
// bound to any account. It is never applied to an account on its own: it is
// offered for an explicit import, accepted by the server only while her
// account has no preferences yet (version 0).

export const DEVICE_CACHE_COOKIE = "dash_pref";
export const LEGACY_APPEARANCE_COOKIE = "dash_appearance";

/** "1.<owner>.<version>.<style>.<ambiance>.<mode>.<motion>.<accent|->". */
const CACHE_FORMAT = "1";

export function serializeDeviceCache(
  owner: string,
  preferences: MemberPreferences,
) {
  const { appearance, version } = preferences;
  return [
    CACHE_FORMAT,
    owner,
    String(version),
    appearance.style,
    appearance.ambiance,
    appearance.mode,
    appearance.motion,
    appearance.accent ? appearance.accent.slice(1) : "-",
  ].join(".");
}

/**
 * The preferences a device cached for `owner`; null if the value is
 * absent, malformed in any way, or another owner's. Strict: one unknown
 * value and the whole cache is ignored (never a half-applied appearance).
 */
export function parseDeviceCache(
  raw: string | undefined | null,
  owner: string,
): MemberPreferences | null {
  if (!raw || raw.length > 200) return null;
  const parts = raw.split(".");
  if (parts.length !== 8) return null;
  const [format, cachedOwner, version, style, ambiance, mode, motion, accent] =
    parts as [string, string, string, string, string, string, string, string];
  if (format !== CACHE_FORMAT || cachedOwner !== owner) return null;
  if (!/^(0|[1-9][0-9]{0,14})$/.test(version)) return null;
  const appearance = strictAppearance(style, ambiance, mode, motion, accent);
  return appearance ? { appearance, version: Number(version) } : null;
}

/**
 * Studio 1's device cookie ("ambiance.mode.motion.accent[.style]", accent
 * without "#" or "-"), read strictly for an import offer: null if absent or
 * if any field is unknown (a malformed or tampered cookie offers nothing).
 */
export function parseLegacyAppearanceCookie(
  raw: string | undefined | null,
): AppearancePreferences | null {
  if (!raw || raw.length > 200) return null;
  const parts = raw.split(".");
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [ambiance, mode, motion, accent, style = "classique"] = parts as [
    string,
    string,
    string,
    string,
    string?,
  ];
  return strictAppearance(style, ambiance, mode, motion, accent);
}

function strictAppearance(
  style: string,
  ambiance: string,
  mode: string,
  motion: string,
  accent: string,
): AppearancePreferences | null {
  if (!(preferenceStyles as readonly string[]).includes(style)) return null;
  if (!(preferenceAmbiances as readonly string[]).includes(ambiance))
    return null;
  if (!(preferenceModes as readonly string[]).includes(mode)) return null;
  if (!(preferenceMotions as readonly string[]).includes(motion)) return null;
  let parsedAccent: string | null = null;
  if (accent !== "-") {
    const result = accentSchema.safeParse(`#${accent}`);
    if (!result.success) return null;
    parsedAccent = result.data;
  }
  return {
    style: style as AppearancePreferences["style"],
    ambiance: ambiance as AppearancePreferences["ambiance"],
    mode: mode as AppearancePreferences["mode"],
    accent: parsedAccent,
    motion: motion as AppearancePreferences["motion"],
  };
}
