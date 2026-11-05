/**
 * A configuration as text, the same whatever the order of its keys: what
 * her studio compares (saved or not, published or not). The server gives
 * her configuration back in its own order (zod's, then PostgreSQL's jsonb,
 * which sorts keys), so a plain JSON.stringify would see a change where
 * there is none.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}
