import type { SiteConfig, SitePalette } from "@/features/sites/config";
import { coreLens } from "@/features/sites/universes";

import { contrast, MIN_CONTRAST } from "./contrast";

// What the server checks before publishing (docs/SITE_PUBLISHING_CONTRACT.md
// § 5): the palette's text pairs a scene renders, at WCAG 4.5:1, in the
// render of each plan (the saved palette, and Core's lens of it). The
// booking button's text is computed (black or white), and any colour reads
// at 4.58:1 or more with one of them: nothing to refuse there. The studio corrects with the
// engine's ensureReadable before publishing; the server only verifies, it
// never rewrites a configuration. Derived pairs (secondary text on day,
// cards) are computed by the engine and guaranteed by ensureReadable, which
// the public renderer applies anyway.

export { contrast, luminance, MIN_CONTRAST } from "./contrast";

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
  /**
   * The plan whose render has this pair: `signature` renders the saved
   * palette, `core` the universe's designed palette with her accent
   * (coreLens). Her plan can change without publishing again: both are
   * checked.
   */
  plan: "core" | "signature";
  where: string;
  /** The measured ratio, rounded to two decimals. */
  ratio: number;
};

function paletteIssues(
  palette: SitePalette,
  plan: ReadabilityIssue["plan"],
): ReadabilityIssue[] {
  const issues: ReadabilityIssue[] = [];
  for (const pair of pairs) {
    const ratio = contrast(palette[pair.text], palette[pair.on]);
    if (ratio < MIN_CONTRAST) {
      issues.push({
        plan,
        where: pair.where,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }
  return issues;
}

/**
 * What would make the published site unreadable, under either plan; empty
 * when both renders read.
 */
export function readabilityIssues(config: SiteConfig): ReadabilityIssue[] {
  return [
    ...paletteIssues(config.tokens.palette, "signature"),
    ...paletteIssues(coreLens(config).tokens.palette, "core"),
  ];
}
