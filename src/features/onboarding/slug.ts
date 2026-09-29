/**
 * Slug preview helpers. The server (`private.normalize_slug`, exposed through
 * checkSlugAction) is the only authority: these functions only mirror it so
 * the link can be previewed while typing, and the UI always shows the slug
 * returned by the server once it is known.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;

// Same list as the businesses_slug_not_reserved constraint.
export const RESERVED_SLUGS = new Set([
  "account",
  "admin",
  "api",
  "app",
  "auth",
  "b",
  "dashboard",
  "help",
  "login",
  "logout",
  "onboarding",
  "register",
  "settings",
  "signin",
  "signup",
  "support",
  "www",
]);

export type SlugIssue = "empty" | "too_short" | "reserved";

// Letters that PostgreSQL's unaccent expands but NFD does not decompose.
const ligatures: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ł: "l",
  þ: "th",
};

function unaccent(value: string) {
  return value
    .toLowerCase()
    .replace(/[ßæœøđłþ]/g, (letter) => ligatures[letter] ?? letter)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Mirror of `private.normalize_slug`: unaccent → lower case → any run outside
 * [a-z0-9] becomes one hyphen → trimmed hyphens → 63 characters at most.
 * "  Studio Mila Lashes ! " → "studio-mila-lashes".
 */
export function slugify(value: string): string {
  return unaccent(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
}

/**
 * Keeps the slug field readable while typing: same rules as `slugify`, except
 * that a trailing hyphen is kept so "studio-" can become "studio-mila".
 */
export function normalizeSlugInput(raw: string): string {
  return unaccent(raw)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX_LENGTH);
}

/** Issues knowable without the server, for instant feedback. */
export function getSlugIssue(input: string): SlugIssue | null {
  const slug = slugify(input);
  if (slug.length === 0) return "empty";
  if (slug.length < SLUG_MIN_LENGTH) return "too_short";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return null;
}

export const slugIssueMessages: Record<SlugIssue, string> = {
  empty: "Choisis le lien de ta page.",
  too_short: `Au moins ${SLUG_MIN_LENGTH} lettres ou chiffres.`,
  reserved: "Ce mot est réservé. Essaie une variante.",
};

/**
 * Candidate alternatives when a slug is unavailable. They are only
 * candidates: the UI checks each one with the server before offering it.
 */
export function suggestSlugs(
  slug: string,
  context: { location?: string; firstName?: string } = {},
): string[] {
  const base = slugify(slug) || "mon-studio";
  const firstName = context.firstName ? slugify(context.firstName) : "";
  const location = context.location
    ? slugify(context.location.split(",")[0] ?? "")
    : "";
  const candidates = [
    location ? `${base}-${location}` : null,
    base.startsWith("studio-") ? null : `studio-${base}`,
    firstName && !base.split("-").includes(firstName)
      ? `${base}-${firstName}`
      : null,
    `${base}-beaute`,
    `${base}-atelier`,
  ];

  return [...new Set(candidates)]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => slugify(candidate))
    .filter(
      (candidate) => candidate !== base && getSlugIssue(candidate) === null,
    );
}
