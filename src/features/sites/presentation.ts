/** Stable keys for navigation and saved layout, independent of the displayed text. */
export const pageSectionKinds = [
  "opening",
  "intro",
  "work",
  "portrait",
  "services",
  "practical",
  "reviews",
] as const;
export type PageSectionKind = (typeof pageSectionKinds)[number];
/**
 * One of her informative sections in her page's order (Higani point 16):
 * `info:<id>`, beside the kinds above.
 */
export type InfoKey = `info:${string}`;
export type PageKey = PageSectionKind | InfoKey;
export const infoKey = (id: string): InfoKey => `info:${id}`;
export const isInfoKey = (key: string): key is InfoKey =>
  key.startsWith("info:");
export type SectionText = {
  title?: string;
  hideTitle?: boolean;
  menu?: string;
};
export type SitePresentation = {
  order?: PageKey[];
  labels?: Partial<Record<PageSectionKind, SectionText>>;
  bookingLabel?: string;
  gallery?: "lookbook" | "arches" | "filmstrip";
  galleryMotion?: "cut" | "settle" | "snap";
};

export const sectionNames: Record<PageSectionKind, string> = {
  opening: "Ouverture",
  intro: "Manifeste",
  work: "Réalisations",
  portrait: "Portrait",
  services: "Prestations",
  practical: "Infos pratiques",
  reviews: "Avis des clientes",
};

export function orderedKinds<Kind extends string>(
  kinds: Kind[],
  order?: readonly string[],
): Kind[] {
  if (!order) return kinds;
  return [
    ...new Set([
      ...order.filter((kind): kind is Kind => kinds.includes(kind as Kind)),
      ...kinds,
    ]),
  ];
}

export function sectionTitle(
  presentation: SitePresentation | undefined,
  kind: PageSectionKind,
  fallback = "",
) {
  const label = presentation?.labels?.[kind];
  return label?.hideTitle ? "" : label?.title?.trim() || fallback;
}

export function bookingLabel(
  presentation: SitePresentation | undefined,
  fallback = "Réserver",
) {
  return presentation?.bookingLabel?.trim() || fallback;
}
