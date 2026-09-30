/**
 * Idempotency key of the appointment creation form.
 *
 * The contract asks for one UUID per logical command: the same key for every
 * retry of the same content (network retry, double click), a new key as soon
 * as the content changes. The key is therefore tied to a fingerprint of the
 * canonical command, never regenerated on re-render.
 */
export type RequestKey = { fingerprint: string; id: string };

export function requestKeyFor(
  previous: RequestKey | null,
  fingerprint: string,
  makeId: () => string = () => crypto.randomUUID(),
): RequestKey {
  return previous && previous.fingerprint === fingerprint
    ? previous
    : { fingerprint, id: makeId() };
}

/** Stable JSON of a command (sorted keys, undefined dropped). */
export function fingerprintOf(value: unknown): string {
  return JSON.stringify(value, (_, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}
