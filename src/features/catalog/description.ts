// Higani point 35: a service's description may be detailed (up to 1000
// characters: what is included, the result, its conditions) without
// weighing on the list. A long one is shown a few lines first, in full
// on demand, her line breaks kept.

/** Long enough to fold: over 160 characters or more than three lines. */
export const longDescription = (text: string | null | undefined) =>
  Boolean(text && (text.length > 160 || text.split("\n").length > 3));
