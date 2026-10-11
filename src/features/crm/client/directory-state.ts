import {
  CLIENT_FILTERS,
  CLIENT_SORTS,
  type ClientFilter,
  type ClientSort,
} from "@/features/crm/types";

// What the directory shows lives in the address (?q=…&filter=…&sort=…), so
// coming back from a profile finds the same list. Anything unknown in the
// address falls back to the default, never to an error.

export type DirectoryQuery = {
  query: string;
  filter: ClientFilter;
  sort: ClientSort;
};

export const DEFAULT_QUERY: DirectoryQuery = {
  query: "",
  filter: "all",
  sort: "name",
};

const MAX_QUERY = 100;

const pick = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

export function parseDirectoryQuery(params: {
  q?: string | string[];
  filter?: string | string[];
  sort?: string | string[];
}): DirectoryQuery {
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  return {
    query: (first(params.q) ?? "").slice(0, MAX_QUERY),
    filter: pick(first(params.filter), CLIENT_FILTERS, DEFAULT_QUERY.filter),
    sort: pick(first(params.sort), CLIENT_SORTS, DEFAULT_QUERY.sort),
  };
}

/** The directory's address for `state`, defaults omitted. */
export function directoryHref(state: DirectoryQuery) {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query);
  if (state.filter !== DEFAULT_QUERY.filter) params.set("filter", state.filter);
  if (state.sort !== DEFAULT_QUERY.sort) params.set("sort", state.sort);
  const search = params.toString();
  return search ? `/app/clients?${search}` : "/app/clients";
}

/**
 * Appends a page to what is shown. Live pagination can return a row twice
 * (see CRM_RELATIONSHIP_READ_MODEL.md): the copy already shown is kept.
 */
export function appendUnique<T extends { id: string }>(shown: T[], page: T[]) {
  const seen = new Set(shown.map((item) => item.id));
  return [...shown, ...page.filter((item) => !seen.has(item.id))];
}
