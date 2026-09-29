import { businessSlugSchema } from "@/features/businesses/schemas/slug";

// UX rule on top of the database constraint (1–63 chars): a one or two
// letter link is almost always a typo and is hard to share.
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;

// Frontend preview only — the backend remains the authority on which slugs
// can be claimed. These would collide with app routes or look official.
export const RESERVED_SLUGS = new Set([
  "admin",
  "aide",
  "api",
  "app",
  "auth",
  "b",
  "booking",
  "compte",
  "connexion",
  "help",
  "inscription",
  "login",
  "onboarding",
  "signup",
  "support",
  "www",
]);

export type SlugIssue =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_chars"
  | "edge_hyphen"
  | "double_hyphen"
  | "reserved";

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Normalises what the user types in the slug field without hiding mistakes:
 * accents are removed, letters lowercased and spaces become hyphens, but
 * other characters are kept so the format error can explain them.
 */
export function normalizeSlugInput(raw: string): string {
  return stripDiacritics(raw)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .slice(0, SLUG_MAX_LENGTH);
}

// Builds a clean slug from a business name: "Studio Mila Lashes" → "studio-mila-lashes".
export function slugify(value: string): string {
  const base = stripDiacritics(value)
    .toLowerCase()
    .replace(/&/g, " et ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base.length <= SLUG_MAX_LENGTH) {
    return base;
  }

  const cut = base.slice(0, SLUG_MAX_LENGTH);
  const lastHyphen = cut.lastIndexOf("-");

  return (
    lastHyphen > SLUG_MIN_LENGTH ? cut.slice(0, lastHyphen) : cut
  ).replace(/-+$/, "");
}

export function getSlugIssue(slug: string): SlugIssue | null {
  if (slug.length === 0) return "empty";
  if (/[^a-z0-9-]/.test(slug)) return "invalid_chars";
  if (slug.startsWith("-") || slug.endsWith("-")) return "edge_hyphen";
  if (slug.includes("--")) return "double_hyphen";
  if (slug.length < SLUG_MIN_LENGTH) return "too_short";
  if (slug.length > SLUG_MAX_LENGTH) return "too_long";
  if (RESERVED_SLUGS.has(slug)) return "reserved";

  // Defence in depth: must also satisfy the shared schema mirrored from SQL.
  return businessSlugSchema.safeParse(slug).success ? null : "invalid_chars";
}

export const slugIssueMessages: Record<SlugIssue, string> = {
  empty: "Choisis le lien de ta page.",
  too_short: `Au moins ${SLUG_MIN_LENGTH} caractères.`,
  too_long: `${SLUG_MAX_LENGTH} caractères maximum.`,
  invalid_chars: "Uniquement des lettres, des chiffres et des tirets.",
  edge_hyphen: "Pas de tiret au début ni à la fin.",
  double_hyphen: "Un seul tiret à la fois.",
  reserved: "Ce mot est réservé. Essaie une variante.",
};

/**
 * Plausible alternatives when a slug is unavailable. Used by the mock
 * adapter; the real backend may return its own suggestions.
 */
export function suggestSlugs(
  slug: string,
  context: { location?: string; firstName?: string } = {},
): string[] {
  const base = slugify(slug) || "mon-studio";
  const candidates = [
    context.location ? `${base}-${slugify(context.location)}` : null,
    base.startsWith("studio-") ? null : `studio-${base}`,
    context.firstName && !base.split("-").includes(slugify(context.firstName))
      ? `${base}-${slugify(context.firstName)}`
      : null,
    `${base}-beaute`,
    `${base}-atelier`,
  ];

  return [...new Set(candidates)]
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter(
      (candidate) => candidate !== base && getSlugIssue(candidate) === null,
    )
    .slice(0, 3);
}
