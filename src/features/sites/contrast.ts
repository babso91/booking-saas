// WCAG 2.1 contrast, shared by the readability check (readability.ts) and
// Core's rendering of a palette (universes.ts, coreLens).

export const MIN_CONTRAST = 4.5;

function channel(value: number) {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of `#rrggbb` (WCAG 2.1). */
export function luminance(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

/** Contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}
