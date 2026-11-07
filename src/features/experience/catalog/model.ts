import type {
  PublicCatalog,
  PublicCatalogGroup,
  PublicCatalogService,
} from "@/features/catalog/model";

// What the scenes receive of her catalogue: exactly the server's public
// projection (get_public_catalog, docs/CATALOG_CONTRACT.md § 8): visible
// categories in her order, their bookable services, then those without a
// category. The lab's fictional catalogue (proto/experience-engine,
// catalog/model.ts) had the same shape; no universe owns or changes it.

/**
 * A service as the scenes take it: with the currency of her catalogue
 * (prices are never said in another one; Codex review of #50).
 */
export type CatalogService = PublicCatalogService & { currency?: string };

export type ShowcaseGroup = Omit<PublicCatalogGroup, "services"> & {
  services: CatalogService[];
};

/** Her showcase, as the scenes take it. */
export const showcaseOf = (catalog: PublicCatalog): ShowcaseGroup[] =>
  catalog.groups.map((group) => ({
    ...group,
    services: group.services.map((service) => ({
      ...service,
      currency: catalog.currency,
    })),
  }));

/**
 * What a service costs and lasts at least, as her booking page says it
 * (serviceFromLine): its required groups' smallest answers added, and
 * whether an answer can add to it ("dès"). For display only: what is booked
 * is always the server's quote.
 */
export function startingAt(
  service: Pick<CatalogService, "priceCents" | "durationMinutes" | "options">,
) {
  let priceCents = service.priceCents;
  let durationMinutes = service.durationMinutes;
  for (const option of service.options) {
    if (!option.required || option.choices.length === 0) continue;
    priceCents += Math.min(...option.choices.map((c) => c.priceDeltaCents));
    durationMinutes += Math.min(
      ...option.choices.map((c) => c.durationDeltaMinutes),
    );
  }
  const choices = service.options.flatMap((option) => option.choices);
  return {
    priceCents,
    durationMinutes,
    priceVaries: choices.some((c) => c.priceDeltaCents > 0),
    durationVaries: choices.some((c) => c.durationDeltaMinutes > 0),
  };
}
