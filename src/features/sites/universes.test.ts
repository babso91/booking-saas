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

describe("coreLens and the readability correction (Codex review of #50)", () => {
  it("a dark accent: once the offered correction is applied, both plans read", async () => {
    // As the studio publishes: her draft rendered, corrected, saved.
    const { ensureReadable } =
      await import("@/features/experience/engine/harmony");
    const { renderConfigOf } =
      await import("@/features/experience/engine/from-site");
    const { savedConfigOf } =
      await import("@/features/experience/studio/saved");
    const { readabilityIssues } = await import("./readability");
    const base = sampleSiteConfig();
    const dark = {
      ...base,
      tokens: {
        ...base.tokens,
        palette: { ...base.tokens.palette, accent: "#4b1f8f" },
      },
    };
    // Only her saved text is at fault; Core's text on her accent reads.
    expect(readabilityIssues(dark).map((issue) => issue.plan)).toEqual([
      "signature",
    ]);
    // Before this fix, Core kept Mila's dark text on her dark accent:
    // publication was refused whatever she accepted.
    const published = savedConfigOf(ensureReadable(renderConfigOf(dark)));
    expect(readabilityIssues(published)).toEqual([]);
  });

  it("the designed palette she chose stays hers under Core after the correction", () => {
    const base = sampleSiteConfig();
    const second = universeDesigns.mila.palettes[1]!.palette;
    const corrected = {
      ...base,
      tokens: {
        ...base.tokens,
        palette: { ...second, accent: "#4b1f8f", onAccent: "#ffffff" },
      },
    };
    expect(coreLens(corrected).tokens.palette).toEqual({
      ...second,
      accent: "#4b1f8f",
      onAccent: "#ffffff",
    });
  });

  it("the designed text on the accent is kept whenever it reads", () => {
    const base = sampleSiteConfig();
    const first = universeDesigns.mila.palettes[0]!.palette;
    const lens = coreLens({
      ...base,
      tokens: {
        ...base.tokens,
        palette: { ...first, onAccent: "#123456" },
      },
    });
    expect(lens.tokens.palette.onAccent).toBe(first.onAccent);
  });
});

describe("coreLens never lets an unreadable render through", () => {
  it("whatever her accent, Core's text on it reads; Core's other pairs are its designed ones", async () => {
    const { contrast } = await import("./readability");
    const base = sampleSiteConfig();
    const steps = ["00", "33", "66", "99", "cc", "ff"];
    for (const universe of Object.keys(universeDesigns) as Array<
      keyof typeof universeDesigns
    >) {
      for (const r of steps)
        for (const g of steps)
          for (const b of steps) {
            const accent = `#${r}${g}${b}`;
            for (const onAccent of ["#000000", "#ffffff", "#808080"]) {
              const lens = coreLens({
                ...base,
                universe,
                tokens: {
                  ...base.tokens,
                  palette: { ...base.tokens.palette, accent, onAccent },
                },
              }).tokens.palette;
              expect(contrast(lens.onAccent, accent)).toBeGreaterThanOrEqual(
                4.5,
              );
              expect(contrast(lens.ink, lens.bg)).toBeGreaterThanOrEqual(4.5);
              expect(
                contrast(lens.inkOnPaper, lens.paper),
              ).toBeGreaterThanOrEqual(4.5);
              expect(contrast(lens.muted, lens.bg)).toBeGreaterThanOrEqual(4.5);
            }
          }
    }
  });
});
