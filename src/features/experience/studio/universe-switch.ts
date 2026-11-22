import type { SiteConfig } from "../engine/config";

// Higani point 121: changing universe changes how her page looks, never
// what it says. Every key of a site is classified here, so a new one
// cannot be added without saying whether it is hers (kept) or the
// universe's (taken from the new one): TypeScript refuses an unclassified
// key. Her services, hours and reviews are not in the site at all.

const KIND: { [Key in keyof SiteConfig]-?: "hers" | "universe" } = {
  universe: "universe",
  tokens: "universe",
  sections: "universe",
  booking: "universe",
  quickBook: "universe",
  brand: "hers",
  content: "hers",
  presentation: "hers",
  hidden: "hers",
  bookingFormat: "hers",
  practical: "hers",
  links: "hers",
};

/** Her keys (what she wrote and chose), as listed above. */
export const herKeys = (Object.keys(KIND) as (keyof SiteConfig)[]).filter(
  (key) => KIND[key] === "hers",
);

/** Her site in another universe: its design, all of her content. */
export function inUniverse(
  draft: SiteConfig,
  universe: SiteConfig,
): SiteConfig {
  const next: Record<string, unknown> = { ...universe };
  for (const key of herKeys) {
    if (draft[key] !== undefined) next[key] = draft[key];
  }
  return next as SiteConfig;
}
