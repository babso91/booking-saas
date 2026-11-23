import { z } from "zod";

// Her "Infos pratiques" in her customers' emails (point 153): the words she
// wrote in her studio and published on her site (Higani point 5), never her
// draft, never typed twice. Only what she filled in is shown. Pure.

export type EmailPractical = {
  /** Her precise address, when her site gives one. */
  address: string | null;
  items: { label: string; lines: string[] }[];
};

const text = z.string().catch("");
const publishedPractical = z
  .object({
    practical: z
      .object({
        address: text,
        access: text,
        instructions: text,
        payment: text,
        accessibility: text,
      })
      .partial()
      .nullish()
      .catch(null),
  })
  .catch({ practical: null });

/** Her lines of text, without control characters (at most 8). */
export function practicalLines(value: string | undefined) {
  return (value ?? "")
    .split(/\r\n|\r|\n/)
    .map((line) =>
      line
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 8);
}

/** From her published site's configuration; null when it says nothing. */
export function practicalOf(config: unknown): EmailPractical | null {
  const practical = publishedPractical.parse(config).practical;
  if (!practical) return null;
  const address = practicalLines(practical.address).join(", ") || null;
  const items = (
    [
      ["Accès", practical.access],
      ["Avant de venir", practical.instructions],
      ["Paiement", practical.payment],
      ["Accessibilité", practical.accessibility],
    ] as const
  )
    .map(([label, value]) => ({ label, lines: practicalLines(value) }))
    .filter((item) => item.lines.length > 0);
  return address || items.length ? { address, items } : null;
}
