import { describe, expect, it } from "vitest";

import { siteConfigSchema } from "@/features/sites/config";

import { renderConfigOf } from "../engine/from-site";
import { demo } from "./photos";
import { firstDraft, savedConfigOf, withDemoPhotos } from "./saved";
import { universes } from "./universes";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("her draft, as the server keeps it", () => {
  it("a first draft is valid for the server, in her name, without any photo", () => {
    for (const universe of Object.values(universes)) {
      const draft = firstDraft(universe, "Atelier Inès");
      const saved = savedConfigOf(draft);
      expect(saved.brand.name).toBe("Atelier Inès");
      expect(saved.content.cover).toBeNull();
      expect(saved.content.works).toEqual([]);
      expect(siteConfigSchema.safeParse(saved).success).toBe(true);
    }
  });

  it("her photos become { asset }; demo photos never leave the studio", () => {
    const draft = {
      ...firstDraft(universes.mila, "Studio"),
      content: {
        cover: demo("1548902378-2ec44c906391"),
        works: [
          { id: "w1", photo: A, title: "Volume", note: "" },
          {
            id: "w2",
            photo: demo("1639629509821-c54cdd984227"),
            title: "Démo",
            note: "",
          },
        ],
        portrait: { photo: B, name: "Inès", role: "", text: "" },
        focals: {
          [A]: { x: 10, y: 20 },
          [demo("1548902378-2ec44c906391")]: { x: 50, y: 50 },
        },
      },
    };
    const saved = savedConfigOf(draft);
    expect(saved.content.cover).toBeNull();
    expect(saved.content.works).toEqual([
      { id: "w1", photo: { asset: A }, title: "Volume", note: "" },
    ]);
    expect(saved.content.portrait.photo).toEqual({ asset: B });
    expect(saved.content.focals).toEqual({ [A]: { x: 10, y: 20 } });
    expect(JSON.stringify(saved)).not.toMatch(/demo:|unsplash/);
    expect(siteConfigSchema.safeParse(saved).success).toBe(true);
  });

  it("read back, her draft is the same in the studio (lossless)", () => {
    const draft = {
      ...firstDraft(universes.alma, "Maison"),
      content: {
        cover: A,
        works: [{ id: "w1", photo: B, title: "Le geste", note: "Lent" }],
        portrait: { photo: null, name: "Alma", role: "", text: "" },
        focals: { [A]: { x: 30, y: 70 } },
      },
    };
    expect(renderConfigOf(savedConfigOf(draft))).toEqual(draft);
  });

  it("the preview can dress her empty places with the universe's photos, only there", () => {
    const draft = firstDraft(universes["nail-lab"], "Nail");
    const dressed = withDemoPhotos(draft, universes["nail-lab"]);
    expect(dressed.content.cover).toMatch(/^demo:/);
    expect(dressed.content.works.length).toBeGreaterThan(0);
    // Her own photos are never replaced.
    const mine = { ...draft, content: { ...draft.content, cover: A } };
    expect(withDemoPhotos(mine, universes["nail-lab"]).content.cover).toBe(A);
    // And saving the dressed preview would still save no demo photo.
    expect(JSON.stringify(savedConfigOf(dressed))).not.toMatch(/demo:/);
  });
});
