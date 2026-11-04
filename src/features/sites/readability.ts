import type { SiteConfig, SitePalette } from "@/features/sites/config";

// What the server checks before publishing (docs/SITE_PUBLISHING_CONTRACT.md
// § 5): the palette's text pairs a scene renders, at WCAG 4.5:1. The
// booking button's text is computed (black or white), and any colour reads
// at 4.58:1 or more with one of them: nothing to refuse there. The studio corrects with the
// engine's ensureReadable before publishing; the server only verifies, it
// never rewrites a configuration. Derived pairs (secondary text on day,
// cards) are computed by the engine and guaranteed by ensureReadable, which
// the public renderer applies anyway.

export const MIN_CONTRAST = 4.5;

function channel(value: number) {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of `#rrggbb` (WCAG 2.1). */
export function luminance(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

/** Contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

const pairs: {
  text: keyof SitePalette;
  on: keyof SitePalette;
  where: string;
}[] = [
  { text: "ink", on: "bg", where: "Le texte sur le fond nuit" },
  { text: "inkOnPaper", on: "paper", where: "Le texte sur le fond jour" },
  {
    text: "onAccent",
    on: "accent",
    where: "Le texte des boutons sur l’accent",
  },
  { text: "muted", on: "bg", where: "Le texte secondaire sur le fond nuit" },
];

export type ReadabilityIssue = {
  where: string;
  /** The measured ratio, rounded to two decimals. */
  ratio: number;
};

/** What would make the published site unreadable; empty when it reads. */
export function readabilityIssues(config: SiteConfig): ReadabilityIssue[] {
  const palette = config.tokens.palette;
  const issues: ReadabilityIssue[] = [];
  for (const pair of pairs) {
    const ratio = contrast(palette[pair.text], palette[pair.on]);
    if (ratio < MIN_CONTRAST) {
      issues.push({ where: pair.where, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return issues;
}
