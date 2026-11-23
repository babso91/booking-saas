import { describe, expect, it } from "vitest";

import { siteAssetIds, siteConfigSchema } from "./config";
import { contrast, readabilityIssues } from "./readability";
import { sampleSiteConfig } from "./site-fixture";

const ASSET = "6f1c1d1e-4a39-4b4f-9a49-1f6b1c4f1a01";

const practical = {
  address: "12 rue Mercière, 69002 Lyon",
  area: "",
  access: "Code 4B12, 2e étage.",
  instructions: "",
  payment: "CB, espèces",
  accessibility: "",
  phone: "+33 6 12 34 56 78",
  email: "contact@example.com",
  showHours: true,
};

describe("siteConfigSchema", () => {
  it("accepts the lab's configuration shape", () => {
    expect(siteConfigSchema.safeParse(sampleSiteConfig()).success).toBe(true);
  });

  it("accepts section labels as plain text and refuses duplicate sections or unknown gallery styles", () => {
    const base = sampleSiteConfig();
    expect(
      siteConfigSchema.parse({
        ...base,
        presentation: {
          labels: {
            intro: { title: "Mon histoire", menu: "À propos", hideTitle: true },
          },
          gallery: "arches",
        },
      }).presentation?.gallery,
    ).toBe("arches");
    for (const presentation of [
      { order: ["reviews", "reviews"] },
      { gallery: "other" },
      { labels: { intro: { title: "<b>html</b>" } } },
      { labels: { other: { menu: "Autre" } } },
    ]) {
      expect(
        siteConfigSchema.safeParse({ ...base, presentation }).success,
      ).toBe(false);
    }
  });

  it("accepts her practical infos, and a version without them", () => {
    expect(
      siteConfigSchema.safeParse(sampleSiteConfig({ practical })).success,
    ).toBe(true);
    const parsed = siteConfigSchema.parse(sampleSiteConfig());
    expect(parsed.practical).toBeUndefined();
  });

  it("her conditions (point 6): optional, plain and bounded", () => {
    const conditions = {
      lateness: "Au-delà de 15 minutes, la prestation peut être écourtée.",
      noShow: "Prévenez-moi au plus tôt.",
      companions: "Les enfants ne peuvent pas être accueillis.",
    };
    expect(
      siteConfigSchema.parse(
        sampleSiteConfig({ practical: { ...practical, ...conditions } }),
      ).practical,
    ).toMatchObject(conditions);
    // A version published before them still reads.
    expect(
      siteConfigSchema.parse(sampleSiteConfig({ practical })).practical
        ?.lateness,
    ).toBeUndefined();
    for (const bad of [
      { lateness: "<i>retard</i>" },
      { noShow: "x".repeat(301) },
      { companions: 3 },
    ]) {
      expect(
        siteConfigSchema.safeParse(
          sampleSiteConfig({ practical: { ...practical, ...bad } } as never),
        ).success,
      ).toBe(false);
    }
  });

  it("her links and WhatsApp (points 3, 4): kept as typed, plain, bounded", () => {
    const links = [
      { network: "instagram", url: "@studio.mila" },
      { network: "other", url: "pas encore fini", label: "Boutique" },
    ];
    // A half-typed link never blocks her draft: the page decides.
    expect(
      siteConfigSchema.parse(
        sampleSiteConfig({
          practical: { ...practical, whatsapp: "+33 6" },
          links,
        } as never),
      ).links,
    ).toEqual(links);
    expect(siteConfigSchema.parse(sampleSiteConfig()).links).toBeUndefined();
    for (const bad of [
      { links: [{ network: "myspace", url: "x" }] },
      { links: [{ network: "website", url: "<a>x</a>" }] },
      { links: [{ network: "website", url: "x".repeat(301) }] },
      { links: [{ network: "website", url: "x", extra: true }] },
      {
        links: Array.from({ length: 9 }, () => ({
          network: "website",
          url: "x.fr",
        })),
      },
      { practical: { ...practical, whatsapp: "x".repeat(31) } },
    ]) {
      expect(
        siteConfigSchema.safeParse(sampleSiteConfig(bad as never)).success,
      ).toBe(false);
    }
  });

  // Higani point 16: her informative sections.
  it("her informative sections (point 16): bounded, unique, plain; old versions still read", () => {
    const base = sampleSiteConfig();
    const section = (id: string) => ({
      id,
      title: "Avant votre rendez-vous",
      text: "Venez les ongles nus.\nMerci.",
    });
    const parse = (infoSections: unknown) =>
      siteConfigSchema.safeParse({ ...base, infoSections });
    expect(parse([section("avant"), section("faq")]).success).toBe(true);
    expect(parse([]).success).toBe(true);
    expect(parse([{ id: "a", title: "", text: "" }]).success).toBe(true);
    expect(parse(["a", "b", "c", "d"].map((id) => section(id))).success).toBe(
      true,
    );
    // A version published before them still reads.
    expect(siteConfigSchema.parse(base).infoSections).toBeUndefined();
    for (const bad of [
      ["a", "b", "c", "d", "e"].map((id) => section(id)),
      [section("a"), section("a")],
      [section("A")],
      [section("a b")],
      [section("")],
      [section("x".repeat(41))],
      [{ ...section("a"), title: "<b>Titre</b>" }],
      [{ ...section("a"), text: "<b>gras</b>" }],
      [{ ...section("a"), title: "x".repeat(49) }],
      [{ ...section("a"), text: "x".repeat(1501) }],
      [{ ...section("a"), extra: true }],
    ])
      expect(parse(bad).success).toBe(false);
    // The limits themselves are accepted.
    expect(
      parse([
        {
          ...section("a"),
          title: "x".repeat(48),
          text: "y".repeat(1500),
        },
      ]).success,
    ).toBe(true);
  });

  it("her page's order accepts « info:<id> » next to the section kinds", () => {
    const base = sampleSiteConfig();
    const order = (value: unknown) =>
      siteConfigSchema.safeParse({
        ...base,
        presentation: { order: value },
      }).success;
    expect(order(["services", "info:abc", "practical"])).toBe(true);
    expect(order(["info:abc-1", "info:def"])).toBe(true);
    expect(order(["info:ABC"])).toBe(false);
    expect(order(["info:"])).toBe(false);
    expect(order(["info:a b"])).toBe(false);
    expect(order(["unknown"])).toBe(false);
    expect(order(["info:abc", "info:abc"])).toBe(false);
  });

  it("refuses practical infos that are not plain, or not a contact", () => {
    for (const bad of [
      { access: "<b>Code</b>" },
      { phone: "appelle-moi" },
      { email: "pas-un-email" },
      { website: "https://example.com" },
      { address: "x".repeat(161) },
    ]) {
      expect(
        siteConfigSchema.safeParse(
          sampleSiteConfig({ practical: { ...practical, ...bad } } as never),
        ).success,
      ).toBe(false);
    }
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

  it("names every unreadable pair and its plan, nothing for a readable palette", () => {
    expect(readabilityIssues(sampleSiteConfig())).toEqual([]);
    const base = sampleSiteConfig();
    // Her own palette (no longer a designed one): Signature renders it as
    // saved; Core renders the universe's palette with her accent.
    const issues = readabilityIssues({
      ...base,
      tokens: {
        ...base.tokens,
        palette: {
          ...base.tokens.palette,
          ink: "#222222",
          onAccent: "#ff5533",
        },
      },
    });
    expect(issues.map((issue) => [issue.plan, issue.where])).toEqual([
      ["signature", "Le texte sur le fond nuit"],
      ["signature", "Le texte des boutons sur l’accent"],
    ]);
  });

  it("an accent whose text reads as saved reads under Core's lens too", () => {
    const base = sampleSiteConfig();
    // Signature: white on a dark violet reads. Core used to keep Mila's
    // designed text (#0b0b0b) on her violet, and refused publication whatever
    // she accepted (Codex review of #50): it now keeps her readable text.
    const config = {
      ...base,
      tokens: {
        ...base.tokens,
        palette: {
          ...base.tokens.palette,
          accent: "#4b1f8f",
          onAccent: "#ffffff",
        },
      },
    };
    expect(readabilityIssues(config)).toEqual([]);
  });
});
