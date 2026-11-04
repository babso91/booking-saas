import { describe, expect, it } from "vitest";

import { siteAssetIds, siteConfigSchema } from "./config";
import { contrast, readabilityIssues } from "./readability";
import { sampleSiteConfig } from "./site-fixture";

const ASSET = "6f1c1d1e-4a39-4b4f-9a49-1f6b1c4f1a01";

describe("siteConfigSchema", () => {
  it("accepts the lab's configuration shape", () => {
    expect(siteConfigSchema.safeParse(sampleSiteConfig()).success).toBe(true);
  });

  it("refuses what the registry does not know", () => {
    for (const bad of [
      { universe: "atelier" },
      {
        sections: [
          { kind: "opening", variant: "spiral" },
          { kind: "services", variant: "index" },
        ],
      },
      { booking: "popup" },
    ]) {
      expect(
        siteConfigSchema.safeParse(sampleSiteConfig(bad as never)).success,
      ).toBe(false);
    }
  });

  it("keeps the opening and the services, once each", () => {
    for (const sections of [
      [{ kind: "services", variant: "index" }],
      [
        { kind: "opening", variant: "bloom" },
        { kind: "intro", variant: "lines" },
      ],
      [
        { kind: "opening", variant: "bloom" },
        { kind: "services", variant: "index" },
        { kind: "services", variant: "tiles" },
      ],
    ]) {
      expect(
        siteConfigSchema.safeParse(sampleSiteConfig({ sections } as never))
          .success,
      ).toBe(false);
    }
    expect(
      siteConfigSchema.safeParse(sampleSiteConfig({ hidden: ["services"] }))
        .success,
    ).toBe(false);
  });

  it("plain text, bounded; colours #rrggbb; photos are her assets, never URLs", () => {
    const base = sampleSiteConfig();
    const bad = [
      { brand: { ...base.brand, name: "<b>Mila</b>" } },
      { brand: { ...base.brand, name: "" } },
      { brand: { ...base.brand, intro: "x".repeat(601) } },
      { tokens: { ...base.tokens, cta: "red" } },
      { content: { ...base.content, cover: "https://example.com/a.jpg" } },
      { content: { ...base.content, cover: { asset: ASSET, url: "x" } } },
    ];
    for (const overrides of bad) {
      expect(
        siteConfigSchema.safeParse(sampleSiteConfig(overrides as never))
          .success,
      ).toBe(false);
    }
    const ok = siteConfigSchema.parse(
      sampleSiteConfig({
        content: {
          ...base.content,
          cover: { asset: ASSET },
          focals: { [ASSET]: { x: 30, y: 60 } },
        },
        tokens: { ...base.tokens, cta: "#AA3355" },
      }),
    );
    expect(ok.tokens.cta).toBe("#aa3355");
    expect(siteAssetIds(ok)).toEqual([ASSET]);
  });
});

describe("readability", () => {
  it("measures WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("names every unreadable pair, and nothing for a readable palette", () => {
    expect(readabilityIssues(sampleSiteConfig())).toEqual([]);
    const base = sampleSiteConfig();
    const issues = readabilityIssues({
      ...base,
      tokens: {
        ...base.tokens,
        palette: {
          ...base.tokens.palette,
          ink: "#222222",
          onAccent: "#7020c0",
        },
      },
    });
    expect(issues.map((issue) => issue.where)).toEqual([
      "Le texte sur le fond nuit",
      "Le texte des boutons sur l’accent",
    ]);
  });
});
