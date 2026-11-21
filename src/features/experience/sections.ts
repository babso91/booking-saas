import type { SceneKind, Section, SiteConfig } from "./engine/config";

// Which of her scenes her clients see, and where the site's index leads.
// A scene with nothing in it (no work published yet, no portrait, no
// words) is not shown on her public site: an empty "Réalisations 00"
// says less than no section at all. In her studio it stays, as the place
// where she adds what it lacks.

function isEmpty(section: Section, config: SiteConfig): boolean {
  switch (section.kind) {
    case "work":
      return config.content.works.length === 0;
    case "portrait": {
      const portrait = config.content.portrait;
      return (
        !portrait.photo &&
        !portrait.name.trim() &&
        !portrait.role.trim() &&
        !portrait.text.trim()
      );
    }
    case "intro":
      return !config.brand.intro.trim();
    case "opening":
    case "services":
      return false;
  }
}

/**
 * Her scenes, in her order: those she did not hide (the opening and her
 * services always show), and, outside her studio, those with something
 * in them.
 */
export function shownSections(
  config: SiteConfig,
  { editing }: { editing: boolean },
): Section[] {
  return config.sections.filter(
    (section) =>
      section.kind === "opening" ||
      section.kind === "services" ||
      (!config.hidden?.includes(section.kind) &&
        (editing || !isEmpty(section, config))),
  );
}

/** The anchor of each scene a client may want to reach directly. */
const DESTINATIONS: Partial<Record<SceneKind, { id: string; label: string }>> =
  {
    services: { id: "prestations", label: "Prestations" },
    work: { id: "realisations", label: "Réalisations" },
    portrait: { id: "portrait", label: "Portrait" },
  };

export type Destination = { kind: SceneKind; id: string; label: string };

/** Where the site's index leads: the shown scenes worth reaching, once. */
export function destinations(sections: readonly Section[]): Destination[] {
  const seen = new Set<SceneKind>();
  const list: Destination[] = [];
  for (const section of sections) {
    const destination = DESTINATIONS[section.kind];
    if (!destination || seen.has(section.kind)) continue;
    seen.add(section.kind);
    list.push({ kind: section.kind, ...destination });
  }
  return list;
}

/** The anchor a shown scene carries (the first of its kind only). */
export function anchorOf(
  sections: readonly Section[],
  position: number,
): string | undefined {
  const kind = sections[position]?.kind;
  if (!kind) return undefined;
  const first = sections.findIndex((section) => section.kind === kind);
  return first === position ? DESTINATIONS[kind]?.id : undefined;
}
