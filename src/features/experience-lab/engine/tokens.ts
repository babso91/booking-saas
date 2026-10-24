import type { CSSProperties } from "react";

import type { GradeId, MotionId, Palette, ShapeId, TypePairId } from "./config";

// The token library: each entry is designed, not a free value. A universe
// picks among them; Signature may mix them across universes.

export const typePairs: Record<
  TypePairId,
  {
    label: string;
    display: string;
    body: string;
    detail: string;
    displayWeight: number;
    displayCase: "none" | "uppercase";
    displayTracking: string;
    /** Small labels: monospace capitals, or quiet sentence case. */
    detailCaps: boolean;
  }
> = {
  didone: {
    label: "Didone éditoriale",
    display: "var(--font-mila-display)",
    body: "var(--font-mila-body)",
    detail: "var(--font-mila-mono)",
    displayWeight: 400,
    displayCase: "none",
    displayTracking: "-0.035em",
    detailCaps: true,
  },
  "soft-serif": {
    label: "Sérif douce",
    display: "var(--font-alma-display)",
    body: "var(--font-alma-body)",
    detail: "var(--font-alma-body)",
    displayWeight: 300,
    displayCase: "none",
    displayTracking: "-0.02em",
    detailCaps: false,
  },
  condensed: {
    label: "Grotesque condensée",
    display: "var(--font-nail-display)",
    body: "var(--font-nail-body)",
    detail: "var(--font-nail-mono)",
    displayWeight: 800,
    displayCase: "uppercase",
    displayTracking: "-0.01em",
    detailCaps: true,
  },
  neutral: {
    label: "Grotesque nette",
    display: "var(--font-lab-sans)",
    body: "var(--font-lab-sans)",
    detail: "var(--font-nail-mono)",
    displayWeight: 600,
    displayCase: "none",
    displayTracking: "-0.045em",
    detailCaps: false,
  },
};

/** Photo grades: one treatment for every photo, good or ordinary. */
export const grades: Record<
  GradeId,
  {
    label: string;
    filter: string;
    wash: { blend: CSSProperties["mixBlendMode"]; opacity: number } | null;
  }
> = {
  silver: {
    label: "Argentique N&B",
    filter: "grayscale(1) contrast(1.15) brightness(.9)",
    wash: null,
  },
  warm: {
    label: "Chaud tamisé",
    filter: "saturate(.55) sepia(.28) contrast(.92) brightness(.88)",
    wash: { blend: "soft-light", opacity: 0.3 },
  },
  natural: { label: "Naturel", filter: "none", wash: null },
  chrome: {
    label: "Chrome",
    filter: "grayscale(1) contrast(1.35) brightness(1.05)",
    wash: { blend: "color", opacity: 0.55 },
  },
};

/** Motion languages: how everything enters, reveals and moves. */
export const motions: Record<
  MotionId,
  {
    label: string;
    ease: [number, number, number, number];
    /** Seconds of a reveal. */
    duration: number;
    /** Opening: a wipe, a slow settle out of the dark, or a snap. */
    entrance: "cut" | "bloom" | "snap";
  }
> = {
  cut: {
    label: "Coupe",
    ease: [0.76, 0, 0.24, 1],
    duration: 0.8,
    entrance: "cut",
  },
  settle: {
    label: "Respiration",
    ease: [0.22, 1, 0.36, 1],
    duration: 1.4,
    entrance: "bloom",
  },
  snap: {
    label: "Impulsion",
    ease: [0.34, 1.56, 0.64, 1],
    duration: 0.55,
    entrance: "snap",
  },
};

export const shapes: Record<
  ShapeId,
  { label: string; radius: number; control: number }
> = {
  sharp: { label: "Net", radius: 0, control: 0 },
  soft: { label: "Doux", radius: 28, control: 18 },
  round: { label: "Rond", radius: 34, control: 999 },
};

export const paletteKeys: { key: keyof Palette; label: string }[] = [
  { key: "bg", label: "Fond nuit" },
  { key: "ink", label: "Texte nuit" },
  { key: "paper", label: "Fond jour" },
  { key: "inkOnPaper", label: "Texte jour" },
  { key: "accent", label: "Accent" },
  { key: "onAccent", label: "Texte sur accent" },
  { key: "muted", label: "Secondaire" },
  { key: "line", label: "Filets" },
];

/** The CSS variables a site renders with. */
export function cssVariables(tokens: {
  palette: Palette;
  type: TypePairId;
  shape: ShapeId;
}): CSSProperties {
  const type = typePairs[tokens.type];
  const shape = shapes[tokens.shape];
  const p = tokens.palette;
  return {
    "--u-bg": p.bg,
    "--u-ink": p.ink,
    "--u-paper": p.paper,
    "--u-ink-on-paper": p.inkOnPaper,
    "--u-muted": p.muted,
    "--u-line": p.line,
    "--u-accent": p.accent,
    "--u-on-accent": p.onAccent,
    "--t-display": type.display,
    "--t-body": type.body,
    "--t-detail": type.detail,
    "--t-display-weight": String(type.displayWeight),
    "--t-display-case": type.displayCase,
    "--t-display-tracking": type.displayTracking,
    "--s-radius": `${shape.radius}px`,
    "--s-control": `${shape.control}px`,
  } as CSSProperties;
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((start) => {
    const channel = parseInt(value.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The first colour readable on `background` (4.5:1), else the best one. */
export function readableOn(background: string, candidates: string[]) {
  return (
    candidates.find((color) => contrast(color, background) >= 4.5) ??
    [...candidates].sort(
      (a, b) => contrast(b, background) - contrast(a, background),
    )[0]!
  );
}

/**
 * The booking buttons' colours: her chosen colour (`tokens.cta`), or the
 * universe's own (`fallback`). The text is never chosen, it is computed:
 * on white, her accent if it reads (the white pill), else black or white.
 */
export function ctaColors(
  tokens: { palette: Palette; cta?: string },
  fallback: string,
) {
  const fill = tokens.cta ?? fallback;
  const { palette } = tokens;
  const candidates =
    fill.toLowerCase() === palette.accent.toLowerCase()
      ? [palette.onAccent, "#FFFFFF", "#111111"]
      : fill.toUpperCase() === "#FFFFFF"
        ? [palette.accent, palette.bg, "#111111"]
        : ["#FFFFFF", "#111111"];
  return { fill, text: readableOn(fill, candidates) };
}
