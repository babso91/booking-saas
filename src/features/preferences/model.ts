import { z } from "zod";

// A professional's personal preferences for her area, as her account keeps
// them (public.member_preferences, one row per membership): the same five
// fields as the appearance engine's `Appearance` (src/features/appearance,
// Studio 1), with the styles it will grow to. Pure and shared by the
// server, the client and the transfer format.
//
// The closed lists below are the database's (private.member_preferences_valid);
// tests/integration/member-preferences.test.ts checks that they agree.

export const preferenceStyles = [
  "classique",
  "studio",
  "ecrin",
  "carnet",
] as const;
export const preferenceAmbiances = ["atelier", "lin", "sauge"] as const;
export const preferenceModes = ["light", "dark", "system"] as const;
export const preferenceMotions = ["standard", "discrete", "none"] as const;

export type PreferenceStyle = (typeof preferenceStyles)[number];
export type PreferenceAmbiance = (typeof preferenceAmbiances)[number];
export type PreferenceMode = (typeof preferenceModes)[number];
export type PreferenceMotion = (typeof preferenceMotions)[number];

/** The shape of Studio 1's `Appearance`, with every style the account accepts. */
export type AppearancePreferences = {
  style: PreferenceStyle;
  ambiance: PreferenceAmbiance;
  mode: PreferenceMode;
  /** "#RRGGBB" (capitals), or null for the style's own. */
  accent: string | null;
  motion: PreferenceMotion;
};

/**
 * Her preferences as the account holds them. `incarnation` is the row's
 * own id (null: no row yet, the defaults); `version` counts its changes
 * (0: no row). Versions are only comparable within one incarnation.
 */
export type MemberPreferences = {
  appearance: AppearancePreferences;
  incarnation: string | null;
  version: number;
};

/**
 * Whose preferences: her membership of a business (business_members.id).
 * Leaving and joining again is another membership, so another context.
 */
export type PreferenceContext = {
  userId: string;
  businessId: string;
  membershipId: string;
};

export function sameContext(a: PreferenceContext, b: PreferenceContext) {
  return (
    a.userId === b.userId &&
    a.businessId === b.businessId &&
    a.membershipId === b.membershipId
  );
}

/** The account's answer: its preferences, and for whom (the server says). */
export type PreferencesSnapshot = {
  context: PreferenceContext;
  preferences: MemberPreferences;
};

/** What she has before saving anything (the table's defaults). */
export const defaultAppearancePreferences: AppearancePreferences = {
  style: "classique",
  ambiance: "atelier",
  mode: "light",
  accent: null,
  motion: "standard",
};

export const noMemberPreferences: MemberPreferences = {
  appearance: defaultAppearancePreferences,
  incarnation: null,
  version: 0,
};

/** "#97493a" and "#97493A" are the same accent; stored in capitals. */
export const accentSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toUpperCase());

export const appearancePreferencesSchema = z
  .object({
    style: z.enum(preferenceStyles),
    ambiance: z.enum(preferenceAmbiances),
    mode: z.enum(preferenceModes),
    accent: accentSchema.nullable(),
    motion: z.enum(preferenceMotions),
  })
  .strict();

/** Only the fields she changed; at least one. */
export const appearanceChangesSchema = appearancePreferencesSchema
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "Au moins une préférence doit changer.",
  });

export type AppearanceChanges = Partial<AppearancePreferences>;

/** The context the device synchronises: refused if it is not the session's. */
const contextSchema = z
  .object({ businessId: z.uuid(), membershipId: z.uuid() })
  .strict();

/** The state her device read: no row (null, 0), or a row's (id, version ≥ 1). */
const expectedSchema = z
  .object({
    incarnation: z.uuid().nullable(),
    version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((value) => (value.incarnation === null) === (value.version === 0), {
    message: "État attendu incohérent.",
  });

export const savePreferencesSchema = z
  .object({
    context: contextSchema,
    expected: expectedSchema,
    changes: appearanceChangesSchema,
  })
  .strict();

export const importDeviceAppearanceSchema = z
  .object({ context: contextSchema, appearance: appearancePreferencesSchema })
  .strict();

/** The database's names for the fields (save_member_preferences's patch). */
export function toDatabaseChanges(changes: AppearanceChanges) {
  const patch: Record<string, string | null> = {};
  if (changes.style !== undefined) patch.style = changes.style;
  if (changes.ambiance !== undefined) patch.ambiance = changes.ambiance;
  if (changes.mode !== undefined) patch.color_mode = changes.mode;
  if (changes.accent !== undefined) patch.accent = changes.accent;
  if (changes.motion !== undefined) patch.motion = changes.motion;
  return patch;
}

export type PreferencesRow = {
  incarnation: string | null;
  style: string;
  ambiance: string;
  color_mode: string;
  accent: string | null;
  motion: string;
  version: number;
};

/**
 * A row read from the database, checked again: a value this code does not
 * know (a newer migration, a style not shipped here) is never passed on as
 * if it were valid; it reads as the default for that field.
 */
export function fromDatabaseRow(row: PreferencesRow): MemberPreferences {
  return {
    appearance: {
      style: pick(
        preferenceStyles,
        row.style,
        defaultAppearancePreferences.style,
      ),
      ambiance: pick(
        preferenceAmbiances,
        row.ambiance,
        defaultAppearancePreferences.ambiance,
      ),
      mode: pick(
        preferenceModes,
        row.color_mode,
        defaultAppearancePreferences.mode,
      ),
      accent: accentSchema.safeParse(row.accent).data ?? null,
      motion: pick(
        preferenceMotions,
        row.motion,
        defaultAppearancePreferences.motion,
      ),
    },
    incarnation: row.incarnation,
    version: row.version,
  };
}

function pick<T extends string>(
  list: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

/** The fields where `next` differs from `current` (what a save sends). */
export function changesBetween(
  current: AppearancePreferences,
  next: AppearancePreferences,
): AppearanceChanges {
  const changes: AppearanceChanges = {};
  if (next.style !== current.style) changes.style = next.style;
  if (next.ambiance !== current.ambiance) changes.ambiance = next.ambiance;
  if (next.mode !== current.mode) changes.mode = next.mode;
  if (next.accent !== current.accent) changes.accent = next.accent;
  if (next.motion !== current.motion) changes.motion = next.motion;
  return changes;
}

export function sameAppearance(
  a: AppearancePreferences,
  b: AppearancePreferences,
) {
  return Object.keys(changesBetween(a, b)).length === 0;
}

/**
 * What the area can draw: a style this build does not ship yet (Écrin and
 * Carnet before their PR) is rendered as Classique, without changing what
 * her account holds; her accent was chosen for that style, so it is left
 * out too. `supported` is the engine's list of finished styles.
 */
export function renderableAppearance<S extends PreferenceStyle>(
  appearance: AppearancePreferences,
  supported: readonly S[],
): Omit<AppearancePreferences, "style"> & { style: S | "classique" } {
  if ((supported as readonly string[]).includes(appearance.style)) {
    return { ...appearance, style: appearance.style as S };
  }
  return { ...appearance, style: "classique", accent: null };
}
