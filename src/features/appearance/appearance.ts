import { contrast, isHexColor, mix, readableTone } from "@/lib/color/contrast";

import {
  ambiances,
  type AmbianceId,
  type Mode,
  type Palette,
} from "./palettes";

// A professional's appearance preferences for her area: ambiance, light or
// dark (or the system's), her accent, the animations she wants. Core.
//
// Stored for now on the device, in a cookie the server reads (so the first
// paint is already hers: no flash, no script): `dash_appearance`. It holds
// presentation only; every value is checked against a closed list when read,
// anything else falls back to the default. Synced to her account later
// (docs/DASHBOARD_EXPERIENCE.md, PR 4).

export type ModePreference = Mode | "system";
export type MotionPreference = "standard" | "discrete" | "none";

export type Appearance = {
  ambiance: AmbianceId;
  mode: ModePreference;
  /** Her accent (#rrggbb), or null for the ambiance's own. */
  accent: string | null;
  motion: MotionPreference;
};

export const APPEARANCE_COOKIE = "dash_appearance";

export const defaultAppearance: Appearance = {
  ambiance: "atelier",
  mode: "light",
  accent: null,
  motion: "standard",
};

const modes: ModePreference[] = ["light", "dark", "system"];
const motions: MotionPreference[] = ["standard", "discrete", "none"];

/** "atelier.system.standard.97493a" ("-" for no accent). */
export function serializeAppearance(value: Appearance) {
  return [
    value.ambiance,
    value.mode,
    value.motion,
    value.accent ? value.accent.slice(1).toLowerCase() : "-",
  ].join(".");
}

/** The cookie's value, read strictly: anything unknown is the default. */
export function parseAppearance(raw: string | undefined | null): Appearance {
  if (!raw) return defaultAppearance;
  const [ambiance, mode, motion, accent] = raw.split(".");
  return {
    ambiance:
      ambiance && ambiance in ambiances
        ? (ambiance as AmbianceId)
        : defaultAppearance.ambiance,
    mode: modes.includes(mode as ModePreference)
      ? (mode as ModePreference)
      : defaultAppearance.mode,
    motion: motions.includes(motion as MotionPreference)
      ? (motion as MotionPreference)
      : defaultAppearance.motion,
    accent:
      accent && isHexColor(`#${accent}`) ? `#${accent.toUpperCase()}` : null,
  };
}

/**
 * The palette of an ambiance in a mode, with her accent if she chose one.
 * Her accent is used as she picked it when it reads; otherwise it is moved,
 * as little as needed, towards the ink: as text on every surface it is
 * written on (4.5:1), its strong tone on its soft background too.
 */
export function paletteFor(
  ambiance: AmbianceId,
  mode: Mode,
  accent: string | null,
): Palette {
  const base = ambiances[ambiance][mode];
  if (!accent) return base;
  const surfaces = [base.paper, base.paperRaised, base.sand];
  const tone = readableTone(accent, surfaces, base.ink);
  const soft = mix(accent, base.paper, mode === "light" ? 0.86 : 0.78);
  const strong = readableTone(
    mix(tone, base.ink, 0.25),
    [...surfaces, soft],
    base.ink,
  );
  return { ...base, accent: tone, accentStrong: strong, accentSoft: soft };
}

const names: [keyof Palette, string][] = [
  ["paper", "--paper"],
  ["paperRaised", "--paper-raised"],
  ["sand", "--sand"],
  ["sandDeep", "--sand-deep"],
  ["line", "--line"],
  ["lineStrong", "--line-strong"],
  ["ink", "--ink"],
  ["inkSoft", "--ink-soft"],
  ["inkMuted", "--ink-muted"],
  ["accent", "--accent"],
  ["accentStrong", "--accent-strong"],
  ["accentSoft", "--accent-soft"],
  ["success", "--success"],
  ["successSoft", "--success-soft"],
  ["successStrong", "--success-strong"],
  ["danger", "--danger"],
  ["dangerSoft", "--danger-soft"],
  ["dangerStrong", "--danger-strong"],
  ["warning", "--warning"],
  ["warningSoft", "--warning-soft"],
  ["warningStrong", "--warning-strong"],
  ["shadowRgb", "--shadow-rgb"],
];

function declarations(palette: Palette, mode: Mode) {
  return [
    ...names.map(([key, name]) => `${name}:${palette[key]};`),
    `--background:${palette.paper};`,
    `--foreground:${palette.ink};`,
    `color-scheme:${mode};`,
  ].join("");
}

/**
 * The CSS of her appearance, for the elements marked `data-appearance`
 * (the area's root, and <html> while she is in it, for panels rendered on
 * <body>). Only validated values reach it (parseAppearance).
 */
export function appearanceCss(value: Appearance) {
  const scope = "[data-appearance]";
  const light = declarations(
    paletteFor(value.ambiance, "light", value.accent),
    "light",
  );
  const dark = declarations(
    paletteFor(value.ambiance, "dark", value.accent),
    "dark",
  );
  if (value.mode === "light") return `${scope}{${light}}`;
  if (value.mode === "dark") return `${scope}{${dark}}`;
  return `${scope}{${light}}@media (prefers-color-scheme: dark){${scope}{${dark}}}`;
}

/** Whether an accent stays exactly as she picked it (shown in the panel). */
export function accentKeptAsIs(
  ambiance: AmbianceId,
  mode: Mode,
  accent: string,
) {
  const base = ambiances[ambiance][mode];
  return [base.paper, base.paperRaised, base.sand].every(
    (surface) => contrast(accent, surface) >= 4.5,
  );
}
