import type { Palette, Section, SiteConfig } from "./config";
import { contrast, readableOn, typePairs } from "./tokens";

// Guardrails of the studio: advice, never a lock. Each variant declares
// the tokens it was designed with; a combination outside them is allowed
// (that is Signature's freedom) and gets a short explanation and a
// one-tap fix. Readability is different: low contrast is flagged as a
// problem, because a customer must be able to read and book.

export type Advice = {
  id: string;
  level: "tip" | "problem";
  text: string;
  /** What "Appliquer" changes. */
  fix?: (config: SiteConfig) => SiteConfig;
};

type Affinity = {
  type?: SiteConfig["tokens"]["type"][];
  motion?: SiteConfig["tokens"]["motion"][];
  why: string;
};

/** What each variant was designed with. */
const affinities: Partial<Record<Section["variant"], Affinity>> = {
  kinetic: {
    type: ["condensed", "neutral"],
    why: "La Cinétique fait défiler le nom en bandeaux : elle est pensée pour une grotesque, condensée ou nette.",
  },
  bloom: {
    motion: ["settle", "cut"],
    why: "L’Éclosion révèle le nom mot à mot : un mouvement en impulsion la rend nerveuse.",
  },
  "didone-cut": {
    type: ["didone", "soft-serif", "condensed"],
    why: "La Coupe Didone montre un seul mot géant : une typographie à fort contraste lui donne son allure.",
  },
  lines: {
    motion: ["settle", "cut"],
    why: "Le manifeste en lignes se lit au rythme du défilement : un mouvement lent le sert mieux.",
  },
  arches: {
    motion: ["settle"],
    why: "Les arches donnent de la profondeur par un parallaxe lent : elles sont pensées pour la respiration.",
  },
};

export function advise(config: SiteConfig): Advice[] {
  const advice: Advice[] = [];
  const { tokens } = config;

  for (const section of config.sections) {
    const affinity = affinities[section.variant];
    if (!affinity) continue;
    if (affinity.type && !affinity.type.includes(tokens.type)) {
      const type = affinity.type[0]!;
      advice.push({
        id: `${section.variant}-type`,
        level: "tip",
        text: `${affinity.why} Essayer « ${typePairs[type].label} » ?`,
        fix: (current) => ({ ...current, tokens: { ...current.tokens, type } }),
      });
    }
    if (affinity.motion && !affinity.motion.includes(tokens.motion)) {
      const motion = affinity.motion[0]!;
      advice.push({
        id: `${section.variant}-motion`,
        level: "tip",
        text: affinity.why,
        fix: (current) => ({
          ...current,
          tokens: { ...current.tokens, motion },
        }),
      });
    }
  }

  // Readability: text on each surface, and on the accent (buttons).
  const pairs: { ink: keyof Palette; on: keyof Palette; where: string }[] = [
    { ink: "ink", on: "bg", where: "Le texte sur le fond nuit" },
    { ink: "inkOnPaper", on: "paper", where: "Le texte sur le fond jour" },
    {
      ink: "onAccent",
      on: "accent",
      where: "Le texte des boutons sur l’accent",
    },
  ];
  for (const { ink, on, where } of pairs) {
    const ratio = contrast(tokens.palette[ink], tokens.palette[on]);
    if (ratio < 4.5) {
      advice.push({
        id: `contrast-${ink}`,
        level: "problem",
        text: `${where} est difficile à lire (contraste ${ratio.toFixed(1)}:1, il faut 4,5:1).`,
        fix: (current) => {
          const palette = current.tokens.palette;
          const fixed = readableOn(palette[on], [
            palette[ink],
            "#FFFFFF",
            "#111111",
          ]);
          return {
            ...current,
            tokens: {
              ...current.tokens,
              palette: { ...palette, [ink]: fixed },
            },
          };
        },
      });
    }
  }

  return advice;
}

/**
 * The public safety net: whatever was experimented in the studio, the
 * published site never ships unreadable text or controls. Applies every
 * readability fix (artistic advice is left to her).
 */
export function ensureReadable(config: SiteConfig): SiteConfig {
  let safe = config;
  for (let round = 0; round < 3; round += 1) {
    const problems = advise(safe).filter((item) => item.level === "problem");
    if (!problems.length) break;
    for (const problem of problems)
      safe = problem.fix ? problem.fix(safe) : safe;
  }
  return safe;
}
