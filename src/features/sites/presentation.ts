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
export type SectionText = {
  title?: string;
  hideTitle?: boolean;
  menu?: string;
};
export type SitePresentation = {
  order?: PageSectionKind[];
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

export function orderedKinds(
  kinds: PageSectionKind[],
  order?: PageSectionKind[],
): PageSectionKind[] {
  if (!order) return kinds;
  return [
    ...new Set([...order.filter((kind) => kinds.includes(kind)), ...kinds]),
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
