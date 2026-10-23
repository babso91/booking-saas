import type { SiteConfig } from "./engine/config";

// The two plans run the same engine; they differ by what the studio may
// change. Core: identity and content in a designed universe, colours among
// its palettes plus her accent. Signature: the composition itself.

export type Plan = "core" | "signature";

export const plans: Record<Plan, { name: string; promise: string }> = {
  core: {
    name: "Core",
    promise:
      "Choisis une expérience magnifique, fais-en ton univers, et commence à recevoir tes réservations.",
  },
  signature: {
    name: "Signature",
    promise:
      "Tu as une direction artistique précise en tête ? Compose ton propre univers.",
  },
};

export type Capability =
  | "content"
  | "palette-preset"
  | "accent"
  | "palette-free"
  | "composition"
  | "style";

const core: Capability[] = ["content", "palette-preset", "accent"];

export const can = (plan: Plan, capability: Capability) =>
  plan === "signature" || core.includes(capability);

/**
 * Going back to Core keeps what Core owns (content, colours) and restores
 * the universe's own composition and style.
 */
export function toCore(config: SiteConfig, origin: SiteConfig): SiteConfig {
  return {
    ...config,
    tokens: { ...origin.tokens, palette: config.tokens.palette },
    sections: origin.sections,
    booking: origin.booking,
    quickBook: origin.quickBook,
  };
}
