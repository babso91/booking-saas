import type { Focal, SiteConfig } from "./engine/config";
import type { UsualHours } from "./practical";

// What a shared link and a search engine read of her page (Higani points
// 26 and 27): a description that says who she is, and her practical
// information as schema.org data. Only what she published: an old version
// without "Infos pratiques" gives her name and description alone.

/** At most `max` characters, cut on a word, an ellipsis when cut. */
export function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** Her page in one or two lines: what she does, where, and her words. */
export function shareDescription({
  name,
  config,
  description,
  location,
}: {
  name: string;
  /** Her published site, if any. */
  config: SiteConfig | null;
  description: string | null;
  location: string | null;
}): string {
  const where = (parts: (string | null | undefined)[]) =>
    parts
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" · ");
  if (config) {
    const line = where([config.brand.kind, config.brand.location]);
    const words = config.brand.intro.trim();
    return clip(
      [line, words].filter(Boolean).join(". ") ||
        `Réservez en ligne chez ${name}.`,
    );
  }
  return clip(
    description?.trim() ||
      [`Réservez en ligne chez ${name}.`, location?.trim()]
        .filter(Boolean)
        .join(" "),
  );
}

/** schema.org days, by Postgres day of week (0: Sunday). */
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Her page as schema.org LocalBusiness data: only what she published. */
export function localBusinessData({
  name,
  description,
  url,
  image,
  config,
  hours,
}: {
  name: string;
  description: string;
  url: string;
  image: string | undefined;
  config: SiteConfig;
  hours: UsualHours[] | null;
}) {
  const practical = config.practical;
  const filled = (value: string | undefined) => value?.trim() || undefined;
  const opening =
    practical?.showHours && hours?.length
      ? hours.map((range) => ({
          "@type": "OpeningHoursSpecification",
          dayOfWeek: `https://schema.org/${DAYS[range.weekday]}`,
          opens: range.startsAt,
          closes: range.endsAt,
        }))
      : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name,
    description,
    url,
    image,
    address: filled(practical?.address),
    areaServed: filled(practical?.area),
    telephone: filled(practical?.phone),
    email: filled(practical?.email),
    openingHoursSpecification: opening,
  };
}

/** JSON for a <script> in her page: never closes the script early. */
export const jsonForScript = (data: unknown) =>
  JSON.stringify(data).replace(/</g, "\\u003c");

/**
 * Where to cut a photo to fill `target`, around its focal point: the size
 * to scale it to (covering the target) and the window to keep.
 */
export function coverCrop(
  photo: { width: number; height: number },
  target: { width: number; height: number },
  focal: Focal = { x: 50, y: 50 },
) {
  const scale = Math.max(
    target.width / photo.width,
    target.height / photo.height,
  );
  const width = Math.max(target.width, Math.round(photo.width * scale));
  const height = Math.max(target.height, Math.round(photo.height * scale));
  const around = (size: number, window: number, percent: number) =>
    Math.min(
      size - window,
      Math.max(0, Math.round((percent / 100) * size - window / 2)),
    );
  return {
    width,
    height,
    left: around(width, target.width, focal.x),
    top: around(height, target.height, focal.y),
  };
}
