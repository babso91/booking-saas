import { describe, expect, it } from "vitest";

import type { SiteConfig } from "./engine/config";
import { renderConfigOf } from "./engine/from-site";
import { sampleSite as savedSample } from "./fixtures/sample-sites";
import {
  anchorOf,
  destinations,
  infoAnchor,
  shownInfoSections,
  shownSections,
  sitePages,
} from "./sections";

// Her saved sample, as the engine renders it (photos as asset ids).
const sampleSite = (universe: Parameters<typeof savedSample>[0]) =>
  renderConfigOf(savedSample(universe));

const kinds = (config: SiteConfig, editing = false) =>
  shownSections(config, { editing }).map((section) => section.kind);

const withWork: SiteConfig["content"]["works"] = [
  { id: "w1", photo: "asset-1", title: "Volume", note: "Pose" },
];

describe("shownSections", () => {
  it("leaves an empty gallery out of her public site", () => {
    const site = sampleSite("mila");
    expect(site.content.works).toEqual([]);
    expect(kinds(site)).not.toContain("work");
  });

  it("keeps the empty gallery in her studio, where she fills it", () => {
    expect(kinds(sampleSite("mila"), true)).toContain("work");
  });

  it("shows a gallery with at least one work, even without its photo", () => {
    const site = sampleSite("mila");
    const config = {
      ...site,
      content: { ...site.content, works: [{ ...withWork[0]!, photo: "" }] },
    };
    expect(kinds(config)).toContain("work");
  });

  it("leaves out a portrait with nothing in it, and an empty intro", () => {
    const site = sampleSite("alma");
    const config: SiteConfig = {
      ...site,
      brand: { ...site.brand, intro: "  " },
      content: {
        ...site.content,
        works: withWork,
        portrait: { photo: null, name: "", role: "", text: "" },
      },
    };
    expect(kinds(config)).not.toContain("portrait");
    expect(kinds(config)).not.toContain("intro");
  });

  it("never leaves out the opening or her services, even hidden", () => {
    const site = sampleSite("nail-lab");
    const config: SiteConfig = {
      ...site,
      hidden: ["opening", "services", "work", "portrait", "intro"],
    };
    expect(kinds(config)).toEqual(
      site.sections
        .map((section) => section.kind)
        .filter((kind) => kind === "opening" || kind === "services"),
    );
  });

  it("respects a scene she hid, in her studio too", () => {
    const site = sampleSite("mila");
    const config: SiteConfig = {
      ...site,
      content: { ...site.content, works: withWork },
      hidden: ["work"],
    };
    expect(kinds(config, true)).not.toContain("work");
  });
});

describe("destinations", () => {
  it("leads to the shown scenes worth reaching, in her order", () => {
    const site = sampleSite("mila");
    const config = {
      ...site,
      content: { ...site.content, works: withWork },
    };
    const shown = shownSections(config, { editing: false });
    const list = destinations(shown);
    expect(list.map((item) => item.label)).toEqual(
      shown
        .map((section) => section.kind)
        .filter((kind) =>
          ["intro", "services", "work", "portrait"].includes(kind),
        )
        .map(
          (kind) =>
            ({
              intro: "À propos",
              services: "Prestations",
              work: "Réalisations",
              portrait: "Portrait",
            })[kind as "intro" | "services" | "work" | "portrait"],
        ),
    );
  });

  it("does not lead to a gallery that is not shown", () => {
    const shown = shownSections(sampleSite("mila"), { editing: false });
    expect(destinations(shown).map((item) => item.id)).not.toContain(
      "realisations",
    );
  });

  it("anchors the first scene of a kind only", () => {
    const sections = [
      { kind: "opening", variant: "kinetic" },
      { kind: "services", variant: "tiles" },
      { kind: "services", variant: "index" },
    ] as SiteConfig["sections"];
    expect(anchorOf(sections, 0)).toBeUndefined();
    expect(anchorOf(sections, 1)).toBe("prestations");
    expect(anchorOf(sections, 2)).toBeUndefined();
    expect(destinations(sections)).toHaveLength(1);
  });
});

// Higani point 16: her informative sections.
describe("shownInfoSections", () => {
  const infoSections = [
    { id: "full", title: "Avant votre rendez-vous", text: "Venez à jeun." },
    { id: "notext", title: "Déroulé", text: "  " },
    { id: "notitle", title: "", text: "Un texte." },
    { id: "empty", title: " ", text: "" },
  ];
  const config = { ...sampleSite("mila"), infoSections };

  it("her clients see only a section with a title and a text", () => {
    expect(
      shownInfoSections(config, { editing: false }).map((item) => item.id),
    ).toEqual(["full"]);
  });

  it("her studio shows every one, to write what it lacks", () => {
    expect(
      shownInfoSections(config, { editing: true }).map((item) => item.id),
    ).toEqual(["full", "notext", "notitle", "empty"]);
  });

  it("none when she added none", () => {
    expect(shownInfoSections(sampleSite("mila"), { editing: false })).toEqual(
      [],
    );
  });
});

describe("sitePages with her informative sections", () => {
  const infos = [
    { id: "avant", title: "Avant votre rendez-vous", text: "Texte" },
    { id: "faq", title: "Questions fréquentes", text: "Réponses" },
  ];
  const site = sampleSite("mila");
  const shown = shownSections(site, { editing: false });
  const keys = (order?: string[]) =>
    sitePages(
      {
        ...site,
        presentation: order ? ({ order } as never) : undefined,
      },
      shown,
      true,
      true,
      infos,
    ).map((page) => page.kind);

  it("by default, after her scenes and before her practical infos and reviews", () => {
    const list = keys();
    const scenes = shown.map((section) => section.kind as string);
    expect(list).toEqual([
      ...scenes,
      "info:avant",
      "info:faq",
      "practical",
      "reviews",
    ]);
  });

  it("respects a saved order containing her sections", () => {
    const list = keys(["info:faq", "practical", "info:avant"]);
    expect(list.slice(0, 3)).toEqual(["info:faq", "practical", "info:avant"]);
    expect(list).toHaveLength(shown.length + 4);
  });

  it("an old order without her sections keeps them after the scenes", () => {
    const list = keys(["reviews"]);
    expect(list[0]).toBe("reviews");
    expect(list).toContain("info:avant");
    expect(list.indexOf("info:avant")).toBeLessThan(list.indexOf("practical"));
  });

  it("leads to section-<id>, named by her title", () => {
    const page = sitePages(site, shown, true, true, infos).find(
      (item) => item.kind === "info:avant",
    );
    expect(page?.link).toEqual({
      kind: "info:avant",
      id: "section-avant",
      label: "Avant votre rendez-vous",
    });
    expect(infoAnchor("avant")).toBe("section-avant");
  });

  it("an untitled section has no link", () => {
    const page = sitePages(site, shown, true, true, [
      { id: "x", title: " ", text: "" },
    ]).find((item) => item.kind === "info:x");
    expect(page).toBeDefined();
    expect(page?.link).toBeUndefined();
  });

  it("without any section, nothing changes", () => {
    expect(sitePages(site, shown, true, true).map((item) => item.kind)).toEqual(
      [...shown.map((section) => section.kind), "practical", "reviews"],
    );
  });
});
