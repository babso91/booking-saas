import { describe, expect, it } from "vitest";

import { bookingTokens } from "./booking-tokens";
import { contrast } from "./tokens";

const palettes = {
  night: {
    bg: "#0E0E0E",
    ink: "#F4F1EC",
    paper: "#F4F1EC",
    inkOnPaper: "#1A1A1A",
    muted: "#8A8580",
    line: "#D9D4CC",
    accent: "#E3462C",
    onAccent: "#FFFFFF",
  },
  pale: {
    bg: "#FBEFF2",
    ink: "#3A1F27",
    paper: "#FFF7F9",
    inkOnPaper: "#B07A88",
    muted: "#C9A3AE",
    line: "#F0DCE2",
    accent: "#F7E1E7",
    onAccent: "#3A1F27",
  },
};

describe("bookingTokens", () => {
  for (const [name, palette] of Object.entries(palettes)) {
    it(`keeps every text readable on the ground and on cards (${name})`, () => {
      const t = bookingTokens({ palette }) as Record<string, string>;
      for (const surface of [t["--paper"]!, t["--paper-raised"]!]) {
        expect(contrast(t["--ink"]!, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--ink-soft"]!, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(t["--on-pop"]!, t["--pop"]!)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("never uses a booking colour that vanishes on the ground", () => {
    const t = bookingTokens({ palette: palettes.pale }) as Record<
      string,
      string
    >;
    expect(contrast(t["--pop"]!, t["--paper"]!)).toBeGreaterThanOrEqual(1.6);
  });

  it("takes her booking colour when she chose one", () => {
    const t = bookingTokens({
      palette: palettes.night,
      cta: "#1F4B99",
    }) as Record<string, string>;
    expect(t["--pop"]).toBe("#1F4B99");
  });

  it("follows her corners: square for a sharp universe", () => {
    const sharp = bookingTokens({
      palette: palettes.night,
      shape: "sharp",
    }) as Record<string, string>;
    expect(sharp["--radius-3xl"]).toBe("0px");
    const soft = bookingTokens({
      palette: palettes.night,
      shape: "soft",
    }) as Record<string, string>;
    expect(soft["--radius-3xl"]).toBe("24px");
  });
});
