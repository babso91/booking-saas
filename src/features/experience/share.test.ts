import { describe, expect, it } from "vitest";

import { renderConfigOf } from "./engine/from-site";
import { sampleSite } from "./fixtures/sample-sites";
import { emptyPractical } from "./practical";
import {
  clip,
  coverCrop,
  jsonForScript,
  localBusinessData,
  shareDescription,
} from "./share";

const site = () => renderConfigOf(sampleSite("mila"));

describe("shareDescription", () => {
  it("says what she does, where, then her words", () => {
    const config = site();
    config.brand = {
      ...config.brand,
      kind: "Extensions de cils",
      location: "Lyon 2e",
      intro: "Un atelier calme, une pose qui vous ressemble.",
    };
    expect(
      shareDescription({
        name: "Studio Mila",
        config,
        description: null,
        location: null,
      }),
    ).toBe(
      "Extensions de cils · Lyon 2e. Un atelier calme, une pose qui vous ressemble.",
    );
  });

  it("stays short enough for a preview, cut on a word", () => {
    const text = clip("mot ".repeat(80));
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith("mot…")).toBe(true);
  });

  it("without a site: her description, else an invitation to book", () => {
    expect(
      shareDescription({
        name: "Atelier Nour",
        config: null,
        description: "  Henné et soins des mains.  ",
        location: "Paris",
      }),
    ).toBe("Henné et soins des mains.");
    expect(
      shareDescription({
        name: "Atelier Nour",
        config: null,
        description: null,
        location: "Paris 11e",
      }),
    ).toBe("Réservez en ligne chez Atelier Nour. Paris 11e");
  });
});

describe("localBusinessData", () => {
  const base = {
    name: "Studio Mila",
    description: "Extensions de cils",
    url: "https://app.example/b/studio-mila",
    image: "https://app.example/b/studio-mila/opengraph-image",
    hours: [
      { weekday: 1, startsAt: "09:00", endsAt: "12:30" },
      { weekday: 1, startsAt: "14:00", endsAt: "19:00" },
    ],
  };

  it("gives only what she published, her hours from her schedule", () => {
    const config = site();
    config.practical = {
      ...emptyPractical,
      address: "12 rue Mercière, 69002 Lyon",
      phone: "04 78 00 00 00",
    };
    const data = localBusinessData({ ...base, config });
    expect(data).toMatchObject({
      "@type": "LocalBusiness",
      name: "Studio Mila",
      address: "12 rue Mercière, 69002 Lyon",
      telephone: "04 78 00 00 00",
    });
    expect(data.email).toBeUndefined();
    expect(data.areaServed).toBeUndefined();
    expect(data.openingHoursSpecification).toEqual([
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "https://schema.org/Monday",
        opens: "09:00",
        closes: "12:30",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "https://schema.org/Monday",
        opens: "14:00",
        closes: "19:00",
      },
    ]);
  });

  it("an old publication, or hours she hides: name and page only", () => {
    const old = site();
    delete old.practical;
    const data = localBusinessData({ ...base, config: old });
    expect(data.address).toBeUndefined();
    expect(data.openingHoursSpecification).toBeUndefined();
    const hidden = site();
    hidden.practical = { ...emptyPractical, showHours: false };
    expect(
      localBusinessData({ ...base, config: hidden }).openingHoursSpecification,
    ).toBeUndefined();
  });

  it("never closes its script early", () => {
    expect(jsonForScript({ name: "</script><b>" })).toBe(
      '{"name":"\\u003c/script>\\u003cb>"}',
    );
  });
});

describe("coverCrop", () => {
  const target = { width: 1200, height: 630 };

  it("a portrait photo keeps the band around her subject", () => {
    expect(
      coverCrop({ width: 1200, height: 1600 }, target, { x: 50, y: 30 }),
    ).toEqual({ width: 1200, height: 1600, left: 0, top: 165 });
  });

  it("never leaves the photo, whatever the focal point", () => {
    expect(
      coverCrop({ width: 1200, height: 800 }, target, { x: 100, y: 100 }),
    ).toEqual({ width: 1200, height: 800, left: 0, top: 170 });
    expect(
      coverCrop({ width: 2400, height: 630 }, target, { x: 0, y: 0 }),
    ).toEqual({ width: 2400, height: 630, left: 0, top: 0 });
  });

  it("a small photo is scaled up to fill the preview", () => {
    expect(coverCrop({ width: 600, height: 600 }, target)).toEqual({
      width: 1200,
      height: 1200,
      left: 0,
      top: 285,
    });
  });
});
