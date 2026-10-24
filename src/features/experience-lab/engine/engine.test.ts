import { describe, expect, it } from "vitest";

import { can, dormant, effective, online } from "../plans";
import { universes } from "../universes";
import { advise, ensureReadable, renderedTextPairs } from "./harmony";
import { contrast, ctaColors, readableOn } from "./tokens";

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

  it("Signature → Core never destroys her settings: Core is a lens on the render, Signature brings them back", () => {
    const universe = universes.mila;
    const saved = universe.signature!.apply({
      ...universe.config,
      brand: { ...universe.config.brand, name: "Atelier Inès" },
    });
    const snapshot = JSON.stringify(saved);
    const core = effective(saved, "core", universe);
    expect(core.brand.name).toBe("Atelier Inès");
    expect(core.sections).toEqual(universe.config.sections);
    expect(core.tokens.motion).toBe(universe.config.tokens.motion);
    expect(JSON.stringify(saved)).toBe(snapshot);
    expect(dormant(saved, universe)).toBe(true);
    expect(effective(saved, "signature", universe)).toBe(saved);
  });

  it("Core keeps her accent on a designed palette, and her own palette only in Signature", () => {
    const universe = universes["nail-lab"];
    const saved = {
      ...universe.config,
      tokens: {
        ...universe.config.tokens,
        palette: {
          ...universe.config.tokens.palette,
          bg: "#FF00FF",
          accent: "#00AA55",
        },
      },
    };
    const core = effective(saved, "core", universe);
    expect(core.tokens.palette.bg).toBe(universe.config.tokens.palette.bg);
    expect(core.tokens.palette.accent).toBe("#00AA55");
  });

  it("the public safety net never ships unreadable text, and leaves art alone", () => {
    const base = universes.alma.config;
    const unreadable = {
      ...base,
      sections: [{ kind: "opening" as const, variant: "kinetic" as const }],
      tokens: {
        ...base.tokens,
        palette: {
          ...base.tokens.palette,
          ink: "#232B25",
          onAccent: "#D8836A",
        },
      },
    };
    const safe = ensureReadable(unreadable);
    expect(advise(safe).filter((item) => item.level === "problem")).toEqual([]);
    expect(safe.sections).toEqual(unreadable.sections);
    expect(safe.tokens.type).toBe(unreadable.tokens.type);
  });

  it("Core keeps what is hers: scenes she hid and her booking button's colour", () => {
    const universe = universes.mila;
    const saved = {
      ...universe.config,
      hidden: ["portrait" as const],
      tokens: { ...universe.config.tokens, cta: "#123456" },
      sections: [...universe.config.sections].reverse(),
    };
    const core = effective(saved, "core", universe);
    expect(core.hidden).toEqual(["portrait"]);
    expect(core.tokens.cta).toBe("#123456");
    // The composition stays the universe's in Core.
    expect(core.sections).toEqual(universe.config.sections);
    expect(dormant({ ...universe.config, hidden: ["intro"] }, universe)).toBe(
      false,
    );
  });

  it.each(Object.values(universes))(
    "$id: every universe presents her portrait, and its Signature keeps it",
    (universe) => {
      expect(
        universe.config.sections.some((item) => item.kind === "portrait"),
      ).toBe(true);
      if (universe.signature) {
        expect(
          universe.signature
            .apply(universe.config)
            .sections.some((item) => item.kind === "portrait"),
        ).toBe(true);
      }
    },
  );

  it.each([
    ["#FFFFFF", "on white: her accent when it reads"],
    ["#0B0B0B", "on ink: white"],
    ["#F2C14E", "on a light colour: black"],
  ])("booking button text is always readable (%s, %s)", (fill) => {
    const palette = universes.mila.config.tokens.palette;
    const { text } = ctaColors({ palette, cta: fill }, palette.accent);
    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
  });

  describe("readability of every text actually rendered (I7)", () => {
    const unreadable = (palette: Parameters<typeof renderedTextPairs>[0]) =>
      renderedTextPairs(palette).filter(
        (pair) => contrast(pair.text, pair.on) < 4.5,
      );

    it("the audit's case: night surface set to the secondary colour (1:1) is flagged, then fixed", () => {
      const mila = universes.mila;
      const signature = mila.signature!.apply(mila.config);
      const custom = {
        ...signature,
        tokens: {
          ...signature.tokens,
          palette: {
            ...signature.tokens.palette,
            bg: signature.tokens.palette.muted,
          },
        },
      };
      expect(
        contrast(custom.tokens.palette.muted, custom.tokens.palette.bg),
      ).toBe(1);
      expect(
        advise(custom)
          .filter((item) => item.level === "problem")
          .map((item) => item.id),
      ).toContain("contrast-muted");
      const safe = ensureReadable(custom);
      expect(unreadable(safe.tokens.palette)).toEqual([]);
      // Her night colour is kept; the texts on it are what moved.
      expect(safe.tokens.palette.bg).toBe(custom.tokens.palette.bg);
    });

    it("400 random palettes: after the safety net, every rendered pair reads (4.5:1)", () => {
      let seed = 42;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      const colour = () =>
        `#${Math.floor(random() * 0xffffff)
          .toString(16)
          .padStart(6, "0")
          .toUpperCase()}`;
      const base = universes.alma.config;
      for (let run = 0; run < 400; run += 1) {
        const palette = {
          bg: colour(),
          ink: colour(),
          paper: colour(),
          inkOnPaper: colour(),
          muted: colour(),
          line: colour(),
          accent: colour(),
          onAccent: colour(),
        };
        const safe = ensureReadable({
          ...base,
          tokens: { ...base.tokens, palette },
        });
        expect(
          unreadable(safe.tokens.palette),
          JSON.stringify(palette),
        ).toEqual([]);
        // Surfaces and accent are her art: never changed by the net.
        expect(safe.tokens.palette.bg).toBe(palette.bg);
        expect(safe.tokens.palette.paper).toBe(palette.paper);
        expect(safe.tokens.palette.accent).toBe(palette.accent);
      }
    });

    it.each(designed)(
      "$name: every rendered pair reads, and the net changes nothing",
      ({ palette }) => {
        expect(unreadable(palette)).toEqual([]);
        const config = {
          ...universes.mila.config,
          tokens: { ...universes.mila.config.tokens, palette },
        };
        expect(ensureReadable(config).tokens.palette).toEqual(palette);
      },
    );
  });

  it.each(["mila", "alma", "nail-lab"] as const)(
    "%s: the published site follows the current plan, Signature → Core → Signature, without losing what was published (I5)",
    (id) => {
      const universe = universes[id];
      const published = {
        design: id,
        config: {
          ...universe.config,
          sections: [
            { kind: "opening" as const, variant: "bloom" as const },
            ...universe.config.sections.slice(1).reverse(),
          ],
          tokens: { ...universe.config.tokens, motion: "snap" as const },
        },
      };
      const signature = online(published, "signature");
      expect(signature.sections).toEqual(published.config.sections);
      for (const plan of ["core", "signature", "core", "signature"] as const) {
        const rendered = online(published, plan);
        expect(rendered.sections).toEqual(
          plan === "core"
            ? universe.config.sections
            : published.config.sections,
        );
        expect(rendered.tokens.motion).toBe(
          plan === "core" ? universe.config.tokens.motion : "snap",
        );
      }
      // Nothing published was rewritten by the lens.
      expect(published.config.sections[0]).toEqual({
        kind: "opening",
        variant: "bloom",
      });
    },
  );
});
