import type { SiteConfig as SavedConfig } from "@/features/sites/config";
import type { SitePlan } from "@/features/sites/data/sites";
import { renderedFor } from "@/features/sites/universes";

import type { SiteConfig } from "../engine/config";

// Three things are kept apart (docs/SITE_PUBLISHING_CONTRACT.md § 3):
//   1. the SAVED configuration: everything the professional set, never
//      destroyed by a change of plan;
//   2. the RIGHTS of her plan (sites.plan, on the server, never set from
//      here): a lens applied when rendering;
//   3. the RENDERED site: the saved config seen through that lens.
// Core ("Simple") edits identity, photos, the universe's palettes with her
// accent and her booking button's colour; Signature ("Créatif") composes:
// variants, order, type, photo grade, motion, shapes, full palette. Going
// back to Core hides those settings from the render; they stay saved and
// return with Signature. The lens is the server's own (renderedFor).

export type Plan = SitePlan;

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
 * The configuration as her plan renders it. The lens only reads and sets
 * tokens, sections, booking and quick booking: her content (photos
 * included, whatever their form here) passes through untouched.
 */
export function effective(config: SiteConfig, plan: Plan): SiteConfig {
  return renderedFor(
    config as unknown as SavedConfig,
    plan,
  ) as unknown as SiteConfig;
}

/** Saved Signature settings that Core does not render (kept, dormant). */
export function dormant(config: SiteConfig) {
  const lens = effective(config, "core");
  return (
    JSON.stringify(lens.tokens) !== JSON.stringify(config.tokens) ||
    JSON.stringify(lens.sections) !== JSON.stringify(config.sections) ||
    lens.booking !== config.booking ||
    lens.quickBook !== config.quickBook
  );
}
