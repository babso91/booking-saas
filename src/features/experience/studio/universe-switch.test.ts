import { describe, expect, it } from "vitest";

import { renderConfigOf } from "../engine/from-site";
import { sampleSite } from "../fixtures/sample-sites";
import { emptyPractical } from "../practical";
import { herKeys, inUniverse } from "./universe-switch";

// Higani point 121: another universe changes her look, never her content.

describe("inUniverse", () => {
  const mila = renderConfigOf(sampleSite("mila"));
  const alma = renderConfigOf(sampleSite("alma"));
  const hers = {
    ...mila,
    brand: { ...mila.brand, name: "Studio Inès", intro: "Mon approche." },
    bookingFormat: "calendar" as const,
    presentation: { labels: { intro: { title: "Mon histoire" } } },
    hidden: ["portrait" as const],
    practical: { ...emptyPractical, address: "12 rue Mercière, Lyon" },
    links: [{ network: "instagram" as const, url: "@studio.ines" }],
  };

  it("keeps all of her content: name, texts, photos, infos, links, labels, format", () => {
    const next = inUniverse(hers, alma);
    for (const key of herKeys) expect(next[key]).toEqual(hers[key]);
    expect(next.links).toEqual([{ network: "instagram", url: "@studio.ines" }]);
  });

  it("takes the new universe's design", () => {
    const next = inUniverse(hers, alma);
    expect(next.universe).toBe(alma.universe);
    expect(next.tokens).toEqual(alma.tokens);
    expect(next.sections).toEqual(alma.sections);
    expect(next.booking).toBe(alma.booking);
    expect(next.quickBook).toBe(alma.quickBook);
  });

  it("what she never filled stays the universe's (nothing invented)", () => {
    const { practical, links, presentation, ...bare } = hers;
    void practical;
    void links;
    void presentation;
    const next = inUniverse(bare, alma);
    expect(next.practical).toEqual(alma.practical);
    expect(next.links).toEqual(alma.links);
  });
});
