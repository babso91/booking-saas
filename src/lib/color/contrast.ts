// Colour arithmetic for readable interfaces (WCAG 2.x relative luminance
// and contrast ratio), on #rrggbb colours. No dependency.

const channels = (hex: string) =>
  [0, 2, 4].map((at) => parseInt(hex.replace("#", "").slice(at, at + 2), 16));

/** WCAG relative luminance of a #rrggbb colour (0 to 1). */
export function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** `color` moved towards `target` by `amount` (0 to 1), in sRGB. */
export function mix(color: string, target: string, amount: number) {
  const from = channels(color);
  const to = channels(target);
  return `#${from
    .map((value, index) =>
      Math.round(value + (to[index]! - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

/**
 * `color` if it reads on every one of `surfaces` (`ratio`, 4.5:1 for text);
 * otherwise the closest tone towards `towardsColor` that does. Its hue is
 * kept as long as possible; `towardsColor` itself must read.
 */
export function readableTone(
  color: string,
  surfaces: string[],
  towardsColor: string,
  ratio = 4.5,
) {
  for (let step = 0; step <= 40; step += 1) {
    const tone =
      step === 0 ? color.toUpperCase() : mix(color, towardsColor, step / 40);
    if (surfaces.every((surface) => contrast(tone, surface) >= ratio))
      return tone;
  }
  return towardsColor.toUpperCase();
}

export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
