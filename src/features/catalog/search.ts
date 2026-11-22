import type { PublicCatalogService } from "./model";

// Finding a service in a long catalogue (Higani point 37): by its name, its
// category, a word of its description or of the questions asked when
// booking it. For display only, in the browser, on the public projection
// already received: nothing is read again, nothing private is searched.

/** From this many bookable services, her catalogue offers a search. */
export const SEARCH_FROM = 8;

type Group<S> = {
  category: { id: string; name: string } | null;
  services: S[];
};

/** Its words, lower case and without accents: "L’Épilation" → l, epilation. */
export function wordsOf(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export const countServices = (groups: readonly Group<unknown>[]) =>
  groups.reduce((sum, group) => sum + group.services.length, 0);

/** A catalogue long enough to need a search. */
export const searchable = (groups: readonly Group<unknown>[]) =>
  countServices(groups) >= SEARCH_FROM;

function wordsOfService(
  service: Pick<PublicCatalogService, "name" | "description" | "options">,
  category: string | undefined,
) {
  return wordsOf(
    [
      service.name,
      category ?? "",
      service.description ?? "",
      ...service.options.flatMap((option) => [
        option.question,
        ...option.choices.map((choice) => choice.label),
      ]),
    ].join(" "),
  );
}

/**
 * Her groups, in her order, keeping the services where every word typed
 * starts one of their words ("cils" finds "Cils & regard", not
 * "sourcils"; "epil" finds "Épilation"). Groups left empty are dropped. An
 * empty query returns her catalogue unchanged.
 */
export function searchCatalog<
  S extends Pick<PublicCatalogService, "name" | "description" | "options">,
  G extends Group<S>,
>(groups: G[], query: string): G[] {
  const typed = wordsOf(query);
  if (!typed.length) return groups;
  return groups
    .map((group) => ({
      ...group,
      services: group.services.filter((service) => {
        const words = wordsOfService(service, group.category?.name);
        return typed.every((part) =>
          words.some((word) => word.startsWith(part)),
        );
      }),
    }))
    .filter((group) => group.services.length > 0);
}

/** "3 prestations", "Aucune prestation ne correspond à « … »". */
export function resultLine(count: number, query: string) {
  if (count === 0)
    return `Aucune prestation ne correspond à « ${query.trim()} »`;
  return count > 1 ? `${count} prestations` : "1 prestation";
}
