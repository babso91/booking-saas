import type { SiteConfig } from "./engine/config";
import { paletteKeys } from "./engine/tokens";
import type { Universe } from "./universes";

// Three things are kept apart:
//   1. the SAVED configuration: everything the professional set, never
//      destroyed by a change of plan;
//   2. the RIGHTS of her plan: a lens applied when rendering;
//   3. the RENDERED site: the saved config seen through that lens (then,
//      for the public, through the readability safety net).
// Core ("Simple") edits identity, photos, her services (business data,
// never behind a plan: catalog/model.ts), the universe's palettes with her
// accent and her booking button's colour; Signature ("Créatif") composes: variants, order, type, photo
// grade, motion, shapes, full palette. Going back to Core hides those
// settings from the render; they stay saved and return with Signature.

export type Plan = "core" | "signature";

export const plans: Record<
  Plan,
  { name: string; mode: string; promise: string }
> = {
  core: {
    name: "Core",
    mode: "Simple",
    promise: "Choisis ton univers, ajoute tes photos, ton nom et tes couleurs.",
  },
  signature: {
    name: "Signature",
    mode: "Créatif",
    promise:
      "Compose tes scènes, change les transitions, expérimente : ton propre studio de direction artistique.",
  },
};

export type Capability =
  | "content"
  | "palette-preset"
  | "accent"
  | "cta"
  | "palette-free"
  | "composition"
  | "style";

const core: Capability[] = ["content", "palette-preset", "accent", "cta"];

export const can = (plan: Plan, capability: Capability) =>
  plan === "signature" || core.includes(capability);

/**
 * The saved config as a plan may render it. Core keeps her content, a
 * designed palette of the universe (her accent on it), her booking
 * button's colour and the universe's own composition and style.
 */
export function effective(
  config: SiteConfig,
  plan: Plan,
  universe: Universe,
): SiteConfig {
  if (plan === "signature") return config;
  const origin = universe.config;
  const designed = universe.palettes.find((item) =>
    paletteKeys.every(
      ({ key }) =>
        key === "accent" || item.palette[key] === config.tokens.palette[key],
    ),
  );
  return {
    ...config,
    tokens: {
      ...origin.tokens,
      cta: config.tokens.cta,
      palette: {
        ...(designed?.palette ?? origin.tokens.palette),
        accent: config.tokens.palette.accent,
      },
    },
    sections: origin.sections,
    booking: origin.booking,
    quickBook: origin.quickBook,
  };
}

/** Saved Signature settings that Core does not render (kept, dormant). */
export function dormant(config: SiteConfig, universe: Universe) {
  const lens = effective(config, "core", universe);
  return (
    JSON.stringify(lens.tokens) !== JSON.stringify(config.tokens) ||
    JSON.stringify(lens.sections) !== JSON.stringify(config.sections) ||
    lens.booking !== config.booking ||
    lens.quickBook !== config.quickBook
  );
}
