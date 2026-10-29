import { contrast, isHexColor, mix, readableTone } from "@/lib/color/contrast";

import {
  ambiances,
  STUDIO_SIGNATURE,
  studioPalettes,
  type AmbianceId,
  type Mode,
  type Palette,
  type StyleId,
} from "./palettes";

// A professional's appearance preferences for her area: its style, the
// ambiance (Classique), light or dark (or the system's), her accent — her
// signature colour in Studio — and the animations she wants. Core.
//
// Stored for now on the device, in a cookie the server reads (so the first
// paint is already hers: no flash, no script): `dash_appearance`. It holds
// presentation only; every value is checked against a closed list when read,
// anything else falls back to the default. Synced to her account later
// (docs/DASHBOARD_EXPERIENCE.md).

export type ModePreference = Mode | "system";
export type MotionPreference = "standard" | "discrete" | "none";

export type Appearance = {
  style: StyleId;
  ambiance: AmbianceId;
  mode: ModePreference;
  /** Her accent (#rrggbb), or null for the style's or ambiance's own. */
  accent: string | null;
  motion: MotionPreference;
};

/** A palette as applied: with the colour of big fields and its ink. */
export type AppliedPalette = Palette & {
  /** Her colour as a field (Studio's "now", a filled button…). */
  signature: string;
  /** Text and icons written on the signature field. */
  onSignature: string;
};

export const APPEARANCE_COOKIE = "dash_appearance";

export const defaultAppearance: Appearance = {
  style: "classique",
  ambiance: "atelier",
  mode: "light",
  accent: null,
  motion: "standard",
};

const styleIds: StyleId[] = ["classique", "studio"];
const modes: ModePreference[] = ["light", "dark", "system"];
const motions: MotionPreference[] = ["standard", "discrete", "none"];

/** "atelier.system.standard.97493a.studio" ("-" for no accent). */
export function serializeAppearance(value: Appearance) {
  return [
    value.ambiance,
    value.mode,
    value.motion,
    value.accent ? value.accent.slice(1).toLowerCase() : "-",
    value.style,
  ].join(".");
}

/**
 * The cookie's value, read strictly: anything unknown is the default.
 * Values written before styles existed (four fields) read as Classique.
 */
export function parseAppearance(raw: string | undefined | null): Appearance {
  if (!raw) return defaultAppearance;
  const [ambiance, mode, motion, accent, style] = raw.split(".");
  return {
    style: styleIds.includes(style as StyleId)
      ? (style as StyleId)
      : defaultAppearance.style,
    // Own keys only: "constructor", "__proto__"… exist on every object.
    ambiance:
      ambiance && Object.hasOwn(ambiances, ambiance)
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

/** The neutrals and default accent a style starts from. */
export function basePalette(
  style: StyleId,
  ambiance: AmbianceId,
  mode: Mode,
): Palette {
  return style === "studio" ? studioPalettes[mode] : ambiances[ambiance][mode];
}

/** The colour she has unless she picks one. */
export const defaultAccent = (
  style: StyleId,
  ambiance: AmbianceId,
  mode: Mode = "light",
) => (style === "studio" ? STUDIO_SIGNATURE : ambiances[ambiance][mode].accent);

/**
 * The palette of a style (and ambiance) in a mode, with her accent if she
 * chose one. Her accent is used as she picked it when it reads; otherwise it
 * is moved, as little as needed, towards the ink: as text on every surface
 * it is written on (4.5:1), its strong tone on its soft background too.
 * As a field (signature), it keeps its own colour and gets the ink, light or
 * dark, that reads best on it; if neither reads, the field is deepened.
 */
export function paletteFor(
  style: StyleId,
  ambiance: AmbianceId,
  mode: Mode,
  accent: string | null,
): AppliedPalette {
  const base = basePalette(style, ambiance, mode);
  const chosen = accent ?? (style === "studio" ? STUDIO_SIGNATURE : null);
  const field = signatureOf(chosen ?? base.accent, base);
  if (!chosen) return { ...base, ...field };
  const surfaces = [base.paper, base.paperRaised, base.sand];
  const tone = readableTone(chosen, surfaces, base.ink);
  const soft = mix(chosen, base.paper, mode === "light" ? 0.86 : 0.78);
  const strong = readableTone(
    mix(tone, base.ink, 0.25),
    [...surfaces, soft],
    base.ink,
  );
  return {
    ...base,
    accent: tone,
    accentStrong: strong,
    accentSoft: soft,
    ...field,
  };
}

/** Light and dark inks of a palette, whichever is which in its mode. */
function inksOf(base: Palette) {
  return contrast(base.ink, "#FFFFFF") > contrast(base.paperRaised, "#FFFFFF")
    ? { dark: base.ink, light: base.paperRaised }
    : { dark: base.paperRaised, light: base.ink };
}

function signatureOf(color: string, base: Palette) {
  const { dark, light } = inksOf(base);
  const on = contrast(light, color) >= contrast(dark, color) ? light : dark;
  if (contrast(on, color) >= 4.5)
    return { signature: color.toUpperCase(), onSignature: on };
  // Mid-tones: keep the hue, move the field away from its ink.
  const away = on === light ? dark : light;
  return { signature: readableTone(color, [on], away), onSignature: on };
}

const names: [keyof AppliedPalette, string][] = [
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
  ["signature", "--signature"],
  ["onSignature", "--on-signature"],
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

function declarations(palette: AppliedPalette, mode: Mode) {
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
  const of = (mode: Mode) =>
    declarations(
      paletteFor(value.style, value.ambiance, mode, value.accent),
      mode,
    );
  if (value.mode === "light") return `${scope}{${of("light")}}`;
  if (value.mode === "dark") return `${scope}{${of("dark")}}`;
  return `${scope}{${of("light")}}@media (prefers-color-scheme: dark){${scope}{${of("dark")}}}`;
}

/** Whether an accent stays exactly as she picked it (shown in the panel). */
export function accentKeptAsIs(
  style: StyleId,
  ambiance: AmbianceId,
  mode: Mode,
  accent: string,
) {
  const base = basePalette(style, ambiance, mode);
  return [base.paper, base.paperRaised, base.sand].every(
    (surface) => contrast(accent, surface) >= 4.5,
  );
}
