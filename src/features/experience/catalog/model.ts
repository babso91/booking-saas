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

export type CatalogService = PublicCatalogService;

export type ShowcaseGroup = PublicCatalogGroup;

/** Her showcase, as the scenes take it. */
export const showcaseOf = (catalog: PublicCatalog): ShowcaseGroup[] =>
  catalog.groups;
