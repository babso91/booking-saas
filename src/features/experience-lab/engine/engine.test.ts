import { describe, expect, it } from "vitest";

import { can, toCore } from "../plans";
import { universes } from "../universes";
import { advise } from "./harmony";
import { contrast, readableOn } from "./tokens";

const designed = Object.values(universes).flatMap((universe) => [
  ...universe.palettes.map((item) => ({
    name: `${universe.id} ${item.name}`,
    palette: item.palette,
  })),
  ...(universe.signature
    ? [
        {
          name: `${universe.id} signature`,
          palette: universe.signature.apply(universe.config).tokens.palette,
        },
      ]
    : []),
]);

describe("experience engine", () => {
  it.each(designed)(
    "$name: text, buttons and secondary text are readable (4.5:1)",
    ({ palette }) => {
      expect(contrast(palette.ink, palette.bg)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(palette.inkOnPaper, palette.paper),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.onAccent, palette.accent)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(palette.muted, palette.bg)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(Object.values(universes))(
    "$id as we designed it raises no advice",
    (universe) => {
      expect(advise(universe.config)).toEqual([]);
    },
  );

  it("an off-design combination is advised, never blocked, and its fix resolves it", () => {
    const config = {
      ...universes.mila.config,
      sections: [{ kind: "opening" as const, variant: "kinetic" as const }],
    };
    const [tip] = advise(config);
    expect(tip?.level).toBe("tip");
    expect(advise(tip!.fix!(config))).toEqual([]);
  });

  it("unreadable colours are a problem, with a fix that makes them readable", () => {
    const palette = {
      ...universes["nail-lab"].config.tokens.palette,
      onAccent: "#3344FF",
    };
    const config = {
      ...universes["nail-lab"].config,
      tokens: { ...universes["nail-lab"].config.tokens, palette },
    };
    const problem = advise(config).find((item) => item.level === "problem");
    expect(problem).toBeTruthy();
    const fixed = problem!.fix!(config).tokens.palette;
    expect(contrast(fixed.onAccent, fixed.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("readableOn keeps the brand colour when it reads, falls back when it does not", () => {
    expect(readableOn("#FFFFFF", ["#2B3BFF", "#111111"])).toBe("#2B3BFF");
    expect(readableOn("#FFFFFF", ["#D4FF00", "#0E0E10"])).toBe("#0E0E10");
  });

  it("Core edits content and colours only; Signature recomposes", () => {
    expect(can("core", "content")).toBe(true);
    expect(can("core", "accent")).toBe(true);
    for (const capability of [
      "palette-free",
      "composition",
      "style",
    ] as const) {
      expect(can("core", capability)).toBe(false);
      expect(can("signature", capability)).toBe(true);
    }
  });

  it("back to Core keeps her content and restores the universe's composition", () => {
    const origin = universes.mila.config;
    const signature = universes.mila.signature!.apply({
      ...origin,
      brand: { ...origin.brand, name: "Atelier Inès" },
    });
    const core = toCore(signature, origin);
    expect(core.brand.name).toBe("Atelier Inès");
    expect(core.sections).toEqual(origin.sections);
    expect(core.tokens.motion).toBe(origin.tokens.motion);
  });
});
