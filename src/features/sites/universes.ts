import type { SiteConfig, SitePalette } from "@/features/sites/config";

// The universes we design, as data only (no React): what the Core lens
// needs. One copy, shared by the server (readability before publishing),
// the engine and the public renderer (docs/SITE_PUBLISHING_CONTRACT.md § 3,
// § 5). Taken from the Experience Engine lab (proto/experience-engine,
// src/features/experience-lab/universes.ts), colours in lower case.

export type UniverseId = SiteConfig["universe"];

export type UniverseDesign = {
  /** Palettes designed for this universe: Core picks among them. */
  palettes: { name: string; palette: SitePalette }[];
  /** Our designed starting point: what Core renders of composition and style. */
  tokens: Pick<
    SiteConfig["tokens"],
    "type" | "grade" | "motion" | "shape" | "palette"
  >;
  sections: SiteConfig["sections"];
  booking: SiteConfig["booking"];
  quickBook: SiteConfig["quickBook"];
};

export const universeDesigns: Record<UniverseId, UniverseDesign> = {
  mila: {
    palettes: [
      {
        name: "Encre",
        palette: {
          bg: "#0b0b0b",
          ink: "#f2f0ec",
          paper: "#f2f0ec",
          inkOnPaper: "#0b0b0b",
          muted: "#8b8883",
          line: "#2a2927",
          accent: "#ff3b1f",
          onAccent: "#0b0b0b",
        },
      },
      {
        name: "Papier",
        palette: {
          bg: "#eceae4",
          ink: "#0b0b0b",
          paper: "#0b0b0b",
          inkOnPaper: "#eceae4",
          muted: "#5f5c57",
          line: "#cfcbc2",
          accent: "#ff3b1f",
          onAccent: "#0b0b0b",
        },
      },
      {
        name: "Bordeaux",
        palette: {
          bg: "#1c0a0e",
          ink: "#f2f0ec",
          paper: "#f2f0ec",
          inkOnPaper: "#0b0b0b",
          muted: "#9c8487",
          line: "#3a1d22",
          accent: "#f2c14e",
          onAccent: "#0b0b0b",
        },
      },
    ],
    tokens: {
      type: "didone",
      grade: "silver",
      motion: "cut",
      shape: "sharp",
      palette: {
        bg: "#0b0b0b",
        ink: "#f2f0ec",
        paper: "#f2f0ec",
        inkOnPaper: "#0b0b0b",
        muted: "#8b8883",
        line: "#2a2927",
        accent: "#ff3b1f",
        onAccent: "#0b0b0b",
      },
    },
    sections: [
      {
        kind: "opening",
        variant: "didone-cut",
      },
      {
        kind: "intro",
        variant: "statement",
      },
      {
        kind: "work",
        variant: "lookbook",
      },
      {
        kind: "portrait",
        variant: "editorial",
      },
      {
        kind: "services",
        variant: "index",
      },
    ],
    booking: "page",
    quickBook: "bar",
  },
  alma: {
    palettes: [
      {
        name: "Olive",
        palette: {
          bg: "#1e2620",
          ink: "#e9ece3",
          paper: "#dce2d4",
          inkOnPaper: "#1e2620",
          muted: "#97a08f",
          line: "#34403a",
          accent: "#d2795a",
          onAccent: "#1e2620",
        },
      },
      {
        name: "Brume",
        palette: {
          bg: "#2e333b",
          ink: "#e7eaee",
          paper: "#e2e5e9",
          inkOnPaper: "#2e333b",
          muted: "#9aa1ab",
          line: "#424852",
          accent: "#c98a6b",
          onAccent: "#1e2620",
        },
      },
      {
        name: "Argile",
        palette: {
          bg: "#3a2923",
          ink: "#f1e7df",
          paper: "#efe4da",
          inkOnPaper: "#3a2923",
          muted: "#b39f92",
          line: "#55413a",
          accent: "#8fa77f",
          onAccent: "#1e2620",
        },
      },
    ],
    tokens: {
      type: "soft-serif",
      grade: "warm",
      motion: "settle",
      shape: "soft",
      palette: {
        bg: "#1e2620",
        ink: "#e9ece3",
        paper: "#dce2d4",
        inkOnPaper: "#1e2620",
        muted: "#97a08f",
        line: "#34403a",
        accent: "#d2795a",
        onAccent: "#1e2620",
      },
    },
    sections: [
      {
        kind: "opening",
        variant: "bloom",
      },
      {
        kind: "intro",
        variant: "lines",
      },
      {
        kind: "portrait",
        variant: "arch",
      },
      {
        kind: "work",
        variant: "arches",
      },
      {
        kind: "services",
        variant: "shelf",
      },
    ],
    booking: "sheet",
    quickBook: "pill",
  },
  "nail-lab": {
    palettes: [
      {
        name: "Cobalt",
        palette: {
          bg: "#0e0e10",
          ink: "#f4f4f0",
          paper: "#f1f0ea",
          inkOnPaper: "#0e0e10",
          muted: "#8e8e96",
          line: "#2a2a30",
          accent: "#2b3bff",
          onAccent: "#f4f4f0",
        },
      },
      {
        name: "Cerise",
        palette: {
          bg: "#0e0e10",
          ink: "#f4f4f0",
          paper: "#f1f0ea",
          inkOnPaper: "#0e0e10",
          muted: "#8e8e96",
          line: "#2a2a30",
          accent: "#ff2d55",
          onAccent: "#0e0e10",
        },
      },
      {
        name: "Acide",
        palette: {
          bg: "#0e0e10",
          ink: "#f4f4f0",
          paper: "#f1f0ea",
          inkOnPaper: "#0e0e10",
          muted: "#8e8e96",
          line: "#2a2a30",
          accent: "#d4ff00",
          onAccent: "#0e0e10",
        },
      },
    ],
    tokens: {
      type: "condensed",
      grade: "chrome",
      motion: "snap",
      shape: "round",
      palette: {
        bg: "#0e0e10",
        ink: "#f4f4f0",
        paper: "#f1f0ea",
        inkOnPaper: "#0e0e10",
        muted: "#8e8e96",
        line: "#2a2a30",
        accent: "#2b3bff",
        onAccent: "#f4f4f0",
      },
    },
    sections: [
      {
        kind: "opening",
        variant: "kinetic",
      },
      {
        kind: "work",
        variant: "filmstrip",
      },
      {
        kind: "intro",
        variant: "statement",
      },
      {
        kind: "portrait",
        variant: "editorial",
      },
      {
        kind: "services",
        variant: "tiles",
      },
    ],
    booking: "sheet",
    quickBook: "pill",
  },
};

const paletteKeys = [
  "bg",
  "ink",
  "paper",
  "inkOnPaper",
  "muted",
  "line",
  "accent",
  "onAccent",
] as const;

/**
 * The configuration as Core renders it (the lab's `effective(config,
 * "core", universe)`): her content, her booking button's colour, a designed
 * palette of her universe (the one hers matches, apart from the accent;
 * otherwise the universe's own) with HER accent, and the universe's own
 * composition and style. Signature renders the configuration as it is.
 * Pure: the saved configuration is never changed.
 */
export function coreLens(config: SiteConfig): SiteConfig {
  const design = universeDesigns[config.universe];
  const designed = design.palettes.find((item) =>
    paletteKeys.every(
      (key) =>
        key === "accent" || item.palette[key] === config.tokens.palette[key],
    ),
  );
  return {
    ...config,
    tokens: {
      ...design.tokens,
      cta: config.tokens.cta,
      palette: {
        ...(designed?.palette ?? design.tokens.palette),
        accent: config.tokens.palette.accent,
      },
    },
    sections: design.sections,
    booking: design.booking,
    quickBook: design.quickBook,
  };
}

/** What a plan renders of a configuration. */
export function renderedFor(
  config: SiteConfig,
  plan: "core" | "signature",
): SiteConfig {
  return plan === "signature" ? config : coreLens(config);
}
