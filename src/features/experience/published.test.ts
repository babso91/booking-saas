import { describe, expect, it } from "vitest";

import { sampleSiteConfig } from "@/features/sites/site-fixture";
import { universeDesigns } from "@/features/sites/universes";

import { renderConfigOf } from "./engine/from-site";
import { publicPhotoBase, publicView } from "./published";

const COVER = "11111111-1111-4111-8111-111111111111";
const WORK = "33333333-3333-4333-8333-333333333333";

const withPhotos = sampleSiteConfig({
  content: {
    cover: { asset: COVER },
    works: [
      { id: "w1", photo: { asset: WORK }, title: "Volume", note: "Pose" },
    ],
    portrait: { photo: null, name: "Mila", role: "Fondatrice", text: "" },
    focals: { [COVER]: { x: 30, y: 40 } },
  },
});

const published = (overrides: Record<string, unknown> = {}) => ({
  versionId: "v",
  number: 1,
  publishedAt: "2026-11-05T10:00:00.000Z",
  plan: "signature" as const,
  schemaVersion: 1,
  config: withPhotos,
  unavailableAssets: [],
  ...overrides,
});

describe("renderConfigOf: the saved configuration as the engine renders it", () => {
  it("a photo is its asset id; every other field is unchanged", () => {
    const view = renderConfigOf(withPhotos);
    expect(view.content.cover).toBe(COVER);
    expect(view.content.works[0]).toEqual({
      id: "w1",
      photo: WORK,
      title: "Volume",
      note: "Pose",
    });
    expect(view.content.portrait.photo).toBeNull();
    expect(view.content.focals).toEqual({ [COVER]: { x: 30, y: 40 } });
    expect({ ...view, content: null }).toEqual({
      ...withPhotos,
      content: null,
    });
  });

  it("a revoked photo is drawn without one; its work keeps its place and words", () => {
    const view = renderConfigOf(withPhotos, [COVER, WORK]);
    expect(view.content.cover).toBeNull();
    expect(view.content.works).toEqual([
      { id: "w1", photo: "", title: "Volume", note: "Pose" },
    ]);
  });
});

describe("publicView: what her clients see", () => {
  it("Signature: her version as published", () => {
    const view = publicView(published());
    expect(view.sections).toEqual(withPhotos.sections);
    expect(view.tokens.palette).toEqual(withPhotos.tokens.palette);
  });

  it("Core: her universe's composition and a designed palette with her accent; her version is not rewritten", () => {
    const signature = sampleSiteConfig({
      sections: [
        { kind: "opening", variant: "kinetic" },
        { kind: "services", variant: "tiles" },
      ],
      tokens: {
        ...withPhotos.tokens,
        palette: { ...withPhotos.tokens.palette, accent: "#2b6cb0" },
        type: "neutral",
      },
    });
    const before = structuredClone(signature);
    const view = publicView(published({ plan: "core", config: signature }));
    expect(view.sections).toEqual(universeDesigns.mila.sections);
    expect(view.tokens.type).toBe(universeDesigns.mila.tokens.type);
    expect(view.tokens.palette.accent).toBe("#2b6cb0");
    expect(signature).toEqual(before);
  });

  it("revoked photos of the published version are drawn without one", () => {
    expect(
      publicView(published({ unavailableAssets: [COVER] })).content.cover,
    ).toBeNull();
  });

  it("its photos come from the public proxy", () => {
    expect(publicPhotoBase("studio mila")).toBe(
      "/api/public/businesses/studio%20mila/site/photos",
    );
  });
});
