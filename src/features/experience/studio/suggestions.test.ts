import { describe, expect, it } from "vitest";

import { showcaseOf } from "../catalog/model";
import type { SiteConfig } from "../engine/config";
import { renderConfigOf } from "../engine/from-site";
import { sampleCatalog, sampleSite } from "../fixtures/sample-sites";
import { emptyPractical } from "../practical";
import { suggestionsFor } from "./suggestions";

// Higani point 124: what would make her page more useful, never required.

const base = renderConfigOf(sampleSite("mila"));
const catalog = showcaseOf(sampleCatalog).map((group) => ({
  ...group,
  services: group.services.map((service) => ({
    ...service,
    description: service.description || "Ce qui est inclus.",
  })),
}));
const complete: SiteConfig = {
  ...base,
  brand: { ...base.brand, intro: "Mon approche." },
  content: {
    ...base.content,
    cover: "cover",
    works: [{ id: "w", photo: "p", title: "", note: "" }],
    portrait: { ...base.content.portrait, photo: "me", text: "Moi." },
  },
  practical: {
    ...emptyPractical,
    address: "12 rue Mercière",
    phone: "04 78 00 00 00",
  },
  links: [{ network: "instagram", url: "@mila" }],
};
const ids = (config: SiteConfig, hasHours: boolean | null = true) =>
  suggestionsFor({ config, catalog, hasHours }).map((item) => item.id);

describe("suggestionsFor", () => {
  it("a page with the essentials: nothing to say", () => {
    expect(ids(complete)).toEqual([]);
  });

  it("only what is missing, most useful first, each leading where it is filled", () => {
    const bare: SiteConfig = {
      ...complete,
      brand: { ...complete.brand, intro: " " },
      content: {
        ...complete.content,
        cover: null,
        works: [],
        portrait: { ...complete.content.portrait, photo: null },
      },
      practical: emptyPractical,
      links: [],
    };
    const list = suggestionsFor({ config: bare, catalog, hasHours: false });
    expect(list.map((item) => [item.id, item.to])).toEqual([
      ["cover", { tab: "photos" }],
      ["intro", { tab: "texts" }],
      ["works", { tab: "photos" }],
      ["portrait", { tab: "photos" }],
      ["place", { tab: "infos" }],
      ["contact", { tab: "infos" }],
      ["hours", { href: "/app/settings/hours", label: "Mes horaires" }],
      ["links", { tab: "infos" }],
    ]);
  });

  it("a scene she chose not to show is not asked for", () => {
    expect(
      ids({
        ...complete,
        hidden: ["portrait", "work", "intro"],
        brand: { ...complete.brand, intro: "" },
        content: {
          ...complete.content,
          works: [],
          portrait: { ...complete.content.portrait, photo: null },
        },
      }),
    ).toEqual([]);
  });

  it("her services: none at all comes first; those without a description are counted", () => {
    expect(
      suggestionsFor({ config: complete, catalog: [], hasHours: true }).map(
        (item) => item.title,
      ),
    ).toEqual(["Ajoute tes prestations"]);
    const plain = catalog.map((group) => ({
      ...group,
      services: group.services.map((service) => ({
        ...service,
        description: null,
      })),
    }));
    const count = plain.flatMap((group) => group.services).length;
    expect(
      suggestionsFor({ config: complete, catalog: plain, hasHours: true }).map(
        (item) => item.title,
      ),
    ).toEqual([
      count > 1 ? `Décris ${count} prestations` : "Décris 1 prestation",
    ]);
  });

  it("her hours unknown here: nothing said about them", () => {
    expect(ids(complete, null)).toEqual([]);
    expect(ids(complete, false)).toEqual(["hours"]);
  });
});
