import { describe, expect, it } from "vitest";

import { paletteFor } from "@/features/appearance/appearance";
import {
  ambiances,
  type AmbianceId,
  type Mode,
  type StyleId,
} from "@/features/appearance/palettes";
import { contrast, mix } from "@/lib/color/contrast";

import { buttonVariants } from "./button";

// Every state of every button variant, in every style, ambiance and mode:
// its text must read on its background (4.5:1). The colours are read from
// the variants' own classes, so a hard-coded colour that only suits one
// palette (a hover in dark mode, say) fails here.

type Palette = ReturnType<typeof paletteFor>;
type State = "idle" | "hover" | "disabled";

const tokens: Record<string, keyof Palette> = {
  ink: "ink",
  "ink-soft": "inkSoft",
  "ink-muted": "inkMuted",
  paper: "paper",
  "paper-raised": "paperRaised",
  sand: "sand",
  "sand-deep": "sandDeep",
  danger: "danger",
  "danger-strong": "dangerStrong",
  success: "success",
  accent: "accent",
};

/** A colour class value (`ink`, `[#382d27]`, `[color-mix(...)]`…) → hex. */
function colourOf(value: string, palette: Palette): string {
  if (value === "white") return "#FFFFFF";
  // `ink/40`: that colour at 40 %, over the page.
  const alpha = /^([a-z-]+)\/(\d+)$/.exec(value);
  if (alpha)
    return mix(
      palette.paper,
      colourOf(alpha[1]!, palette),
      Number(alpha[2]) / 100,
    );
  if (value === "transparent") return palette.paper; // drawn on the page
  const hex = /^\[(#[0-9a-fA-F]{6})\]$/.exec(value);
  if (hex) return hex[1]!.toUpperCase();
  const mixed =
    /^\[color-mix\(in_srgb,var\(--([a-z-]+)\)_(\d+)%,var\(--([a-z-]+)\)\)\]$/.exec(
      value,
    );
  if (mixed) {
    const [, from, share, to] = mixed;
    return mix(
      palette[tokens[from!]!] as string,
      palette[tokens[to!]!] as string,
      1 - Number(share) / 100,
    );
  }
  const token = tokens[value];
  if (!token) throw new Error(`Unknown colour class: ${value}`);
  return palette[token] as string;
}

/** The background and text a variant has in a state. */
function resolve(classes: string, state: State, palette: Palette) {
  const pick = (kind: "bg" | "text") => {
    const all = classes.split(/\s+/);
    const plain = all.find((name) => name.startsWith(`${kind}-`));
    const forState = all.find((name) => name.startsWith(`${state}:${kind}-`));
    const value = (forState ?? plain)!
      .replace(/^[a-z]+:/, "")
      .slice(kind.length + 1);
    return colourOf(value, palette);
  };
  return { bg: pick("bg"), text: pick("text") };
}

const looks = (["classique", "studio"] as StyleId[]).flatMap((style) =>
  (Object.keys(ambiances) as AmbianceId[]).flatMap((ambiance) =>
    (["light", "dark"] as Mode[]).map((mode) => ({ style, ambiance, mode })),
  ),
);

describe("buttons read in every state, style, ambiance and mode", () => {
  it.each(looks)("$style · $ambiance · $mode", ({ style, ambiance, mode }) => {
    const palette = paletteFor(style, ambiance, mode, null);
    const unreadable: string[] = [];
    for (const [variant, classes] of Object.entries(buttonVariants)) {
      for (const state of ["idle", "hover", "disabled"] as State[]) {
        const { bg, text } = resolve(classes, state, palette);
        const ratio = contrast(text, bg);
        if (ratio < 4.5)
          unreadable.push(
            `${variant} ${state}: ${text} on ${bg} (${ratio.toFixed(2)})`,
          );
      }
    }
    expect(unreadable).toEqual([]);
  });

  it("the focus ring (her accent) stands out from the page (3:1)", () => {
    for (const { style, ambiance, mode } of looks) {
      const palette = paletteFor(style, ambiance, mode, null);
      expect(contrast(palette.accent, palette.paper)).toBeGreaterThanOrEqual(3);
      expect(
        contrast(palette.accent, palette.paperRaised),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
