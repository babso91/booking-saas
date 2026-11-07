// How wide a word sets, in em, in the universes' display faces: measured
// on Bodoni Moda, Newsreader, Big Shoulders and Geist at their display
// weights and tracking, rounded up to the widest of them. An estimate
// only, so it carries a margin: a name may set a little smaller than it
// could, never wider than its frame.

const NARROW_LOWER = new Set([..."fijlrt'’.-"]);
const WIDE_LOWER = new Set([..."mw"]);
const NARROW_UPPER = new Set([..."I'’.-"]);
const WIDE_UPPER = new Set([..."MW"]);
const MARGIN = 1.08;

export function displayWidthEm(word: string, uppercase: boolean): number {
  // "è" sets as wide as "e": accents removed, the letter kept.
  const letters = [...word.normalize("NFD").replace(/\p{M}/gu, "")];
  let width = 0;
  for (const raw of letters) {
    const upper = uppercase || raw !== raw.toLowerCase();
    const letter = uppercase ? raw.toUpperCase() : raw;
    if (upper)
      width += WIDE_UPPER.has(letter)
        ? 1
        : NARROW_UPPER.has(letter)
          ? 0.35
          : 0.75;
    else
      width += WIDE_LOWER.has(letter)
        ? 0.82
        : NARROW_LOWER.has(letter)
          ? 0.4
          : 0.58;
  }
  return Math.max(width, 1) * MARGIN;
}
