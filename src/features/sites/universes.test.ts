import { describe, expect, it } from "vitest";

import { sampleSiteConfig } from "./site-fixture";
import { coreLens, renderedFor, universeDesigns } from "./universes";

describe("coreLens (the lab's effective, Core)", () => {
  it("keeps her content, her accent and her button; renders the universe's composition", () => {
    const base = sampleSiteConfig();
    const signature = {
      ...base,
      tokens: {
        ...base.tokens,
        type: "condensed" as const,
        motion: "snap" as const,
        cta: "#123456",
      },
      sections: [
        { kind: "services" as const, variant: "tiles" as const },
        { kind: "opening" as const, variant: "kinetic" as const },
      ],
      booking: "page" as const,
    };
    const lens = coreLens(signature);
    const mila = universeDesigns.mila;
    expect(lens.brand).toEqual(signature.brand);
    expect(lens.content).toEqual(signature.content);
    expect(lens.tokens).toEqual({
      ...mila.tokens,
      cta: "#123456",
      palette: {
        ...mila.palettes[0]!.palette,
        accent: signature.tokens.palette.accent,
      },
    });
    expect(lens.sections).toEqual(mila.sections);
    expect(lens.booking).toBe(mila.booking);
    expect(renderedFor(signature, "signature")).toBe(signature);
    // The saved configuration is untouched.
    expect(signature.tokens.type).toBe("condensed");
  });

  it("keeps the designed palette she chose (apart from the accent), else the universe's own", () => {
    const base = sampleSiteConfig();
    const second = universeDesigns.mila.palettes[1]!.palette;
    const chosen = {
      ...base,
      tokens: { ...base.tokens, palette: { ...second, accent: "#00aa55" } },
    };
    expect(coreLens(chosen).tokens.palette).toEqual({
      ...second,
      accent: "#00aa55",
    });
    const free = {
      ...base,
      tokens: { ...base.tokens, palette: { ...second, ink: "#777777" } },
    };
    expect(coreLens(free).tokens.palette).toEqual({
      ...universeDesigns.mila.tokens.palette,
      accent: second.accent,
    });
  });

  it("every designed palette reads, with its own accent", async () => {
    const { contrast } = await import("./readability");
    for (const design of Object.values(universeDesigns)) {
      for (const { palette } of design.palettes) {
        expect(contrast(palette.ink, palette.bg)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(palette.inkOnPaper, palette.paper),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(palette.onAccent, palette.accent),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.muted, palette.bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
