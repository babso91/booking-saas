import { describe, expect, it } from "vitest";

import { contrast } from "@/lib/color/contrast";

import {
  appearanceCss,
  defaultAppearance,
  paletteFor,
  parseAppearance,
  serializeAppearance,
} from "./appearance";
import {
  ambiances,
  type AmbianceId,
  type Mode,
  type Palette,
} from "./palettes";

// Every text colour the professional area writes on every surface it writes
// it on (counted in the screens: text-* on bg-*), with the ratio it needs.
// Secondary text (ink-muted) is never written on sand: the two places that
// did (status and timeline pills, 4.16:1) now use ink-soft.
const pairs: [keyof Palette, keyof Palette][] = [
  ["ink", "paper"],
  ["ink", "paperRaised"],
  ["ink", "sand"],
  ["ink", "accentSoft"],
  ["inkSoft", "paper"],
  ["inkSoft", "paperRaised"],
  ["inkSoft", "sand"],
  ["inkMuted", "paper"],
  ["inkMuted", "paperRaised"],
  ["paperRaised", "ink"],
  ["paperRaised", "success"],
  ["paperRaised", "danger"],
  ["accent", "paper"],
  ["accent", "paperRaised"],
  ["accentStrong", "accentSoft"],
  ["accentStrong", "paper"],
  ["success", "successSoft"],
  ["success", "paper"],
  ["success", "paperRaised"],
  ["successStrong", "successSoft"],
  ["warning", "warningSoft"],
  ["warning", "paper"],
  ["warningStrong", "warningSoft"],
  ["danger", "paper"],
  ["danger", "paperRaised"],
  ["danger", "dangerSoft"],
  ["dangerStrong", "dangerSoft"],
];

const all = (Object.keys(ambiances) as AmbianceId[]).flatMap((ambiance) =>
  (["light", "dark"] as Mode[]).map((mode) => ({ ambiance, mode })),
);

const unreadable = (palette: Palette) =>
  pairs
    .map(([text, on]) => ({
      pair: `${text} on ${on}`,
      ratio: Number(contrast(palette[text], palette[on]).toFixed(2)),
    }))
    .filter((item) => item.ratio < 4.5);

describe("the professional area's ambiances", () => {
  it.each(all)(
    "$ambiance · $mode: every text the screens use reads on its surface (4.5:1)",
    ({ ambiance, mode }) => {
      expect(unreadable(ambiances[ambiance][mode])).toEqual([]);
    },
  );

  it("Atelier · light is the identity the app always had (globals.css)", () => {
    const palette = ambiances.atelier.light;
    expect(palette.paper).toBe("#F6F1EA");
    expect(palette.ink).toBe("#231C18");
    expect(palette.accent).toBe("#97493A");
  });

  it.each(all)(
    "$ambiance · $mode: 300 random accents, each made readable where it is written",
    ({ ambiance, mode }) => {
      let seed = 7;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      for (let run = 0; run < 300; run += 1) {
        const accent = `#${Math.floor(random() * 0xffffff)
          .toString(16)
          .padStart(6, "0")
          .toUpperCase()}`;
        const palette = paletteFor(ambiance, mode, accent);
        expect(unreadable(palette), accent).toEqual([]);
      }
    },
  );

  it("an accent that already reads is kept exactly as she picked it", () => {
    expect(paletteFor("atelier", "light", "#2B2B6E").accent).toBe("#2B2B6E");
    // A pale yellow cannot be text on ivory: moved towards the ink.
    const pale = paletteFor("atelier", "light", "#F2D45C").accent;
    expect(pale).not.toBe("#F2D45C");
    expect(
      contrast(pale, ambiances.atelier.light.paper),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("her preference, as stored on the device", () => {
  it("round-trips", () => {
    const value = {
      ambiance: "sauge" as const,
      mode: "system" as const,
      motion: "discrete" as const,
      accent: "#7A3E66",
    };
    expect(parseAppearance(serializeAppearance(value))).toEqual(value);
  });

  it.each([
    undefined,
    "",
    "unknown.dark.none.-",
    "lin.purple.none.-",
    "lin.dark.fast.-",
    "lin.dark.none.zzzzzz",
    "lin.dark.none.12345",
    "atelier.light.standard.97493a;}body{display:none",
  ])("anything unknown falls back, value by value (%s)", (raw) => {
    const parsed = parseAppearance(raw);
    expect(Object.keys(parsed).sort()).toEqual(
      Object.keys(defaultAppearance).sort(),
    );
    expect(appearanceCss(parsed)).not.toMatch(/display:none|zzzzzz/);
    if (raw?.startsWith("lin.dark")) expect(parsed.ambiance).toBe("lin");
  });

  it("system mode follows the device, in CSS (no script, no flash)", () => {
    const css = appearanceCss({ ...defaultAppearance, mode: "system" });
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("color-scheme:dark");
    expect(appearanceCss(defaultAppearance)).not.toContain("@media");
  });
});
