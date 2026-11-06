import type { PublicCatalog, ServiceOption } from "@/features/catalog/model";

// Her catalogue as screens read it, from one reading (getCatalogAction):
// the professional's sections, the moves she makes in them, and what her
// clients will see. Pure functions; every write goes through the Server
// Actions and the database decides (docs/CATALOG_CONTRACT.md).

export type CatalogCategory = {
  id: string;
  name: string;
  visible: boolean;
  displayOrder: number;
  version: number;
};

export type CatalogEntry = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  active: boolean;
  displayOrder: number;
  categoryId: string | null;
  options: ServiceOption[];
};

/** A section of her list: a category (in her order), or none, last. */
export type Section<S> = { category: CatalogCategory | null; services: S[] };

const byOrder = <T extends { displayOrder: number; name: string; id: string }>(
  a: T,
  b: T,
) =>
  a.displayOrder - b.displayOrder ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Her list as she organises it: every category, even empty or hidden (they
 * are hers to fill or show), then the services without one. Without any
 * category, one section holds them all.
 */
export function sectionsOf<
  S extends {
    id: string;
    name: string;
    displayOrder: number;
    categoryId: string | null;
  },
>(categories: CatalogCategory[], services: S[]): Section<S>[] {
  const ordered = [...services].sort(byOrder);
  const known = new Set(categories.map((category) => category.id));
  const sections: Section<S>[] = [...categories]
    .sort(byOrder)
    .map((category) => ({
      category,
      services: ordered.filter((service) => service.categoryId === category.id),
    }));
  // A category unknown to this reading (deleted meanwhile) is none.
  const loose = ordered.filter(
    (service) => !service.categoryId || !known.has(service.categoryId),
  );
  if (loose.length > 0 || sections.length === 0)
    sections.push({ category: null, services: loose });
  return sections;
}

/**
 * Every service id in the new order after moving `serviceId` one place
 * within its section (reorderServicesAction takes the complete list). The
 * services of other sections keep their places. Null: it is already first
 * or last of its section.
 */
export function orderAfterMove<
  S extends {
    id: string;
    name: string;
    displayOrder: number;
    categoryId: string | null;
  },
>(
  categories: CatalogCategory[],
  services: S[],
  serviceId: string,
  delta: -1 | 1,
): string[] | null {
  const section = sectionsOf(categories, services).find((item) =>
    item.services.some((service) => service.id === serviceId),
  );
  if (!section) return null;
  const at = section.services.findIndex((service) => service.id === serviceId);
  const neighbour = section.services[at + delta];
  if (!neighbour) return null;
  const ids = [...services].sort(byOrder).map((service) => service.id);
  const from = ids.indexOf(serviceId);
  const to = ids.indexOf(neighbour.id);
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}

/** Every category id after moving one a place (all of them, once). */
export function categoriesAfterMove(
  categories: CatalogCategory[],
  categoryId: string,
  delta: -1 | 1,
): string[] | null {
  const ids = [...categories].sort(byOrder).map((category) => category.id);
  const from = ids.indexOf(categoryId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}

/**
 * What her clients see, from her own reading: the same projection as
 * public.get_public_catalog (the lab's showcase()). Visible categories with
 * at least one active service, in her order; services of a hidden category
 * left out; services without a category last, without a heading. The
 * mini-site and its universes only ever receive this.
 */
export function showcase(
  categories: CatalogCategory[],
  services: CatalogEntry[],
  currency: string,
): PublicCatalog {
  const visible = new Map(
    categories.map((category) => [category.id, category.visible]),
  );
  const bookable = services.filter(
    (service) =>
      service.active &&
      (service.categoryId === null || visible.get(service.categoryId) === true),
  );
  return {
    currency,
    groups: sectionsOf(categories, bookable)
      .filter((section) => section.services.length > 0)
      .map((section) => ({
        category: section.category
          ? { id: section.category.id, name: section.category.name }
          : null,
        services: section.services.map((service) => ({
          id: service.id,
          name: service.name,
          description: service.description,
          durationMinutes: service.durationMinutes,
          priceCents: service.priceCents,
          options: service.options,
        })),
      })),
  };
}
