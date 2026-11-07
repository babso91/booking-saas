import type { PublicCatalog } from "@/features/catalog/model";
import type { SiteConfig } from "@/features/sites/config";
import { universeDesigns, type UniverseId } from "@/features/sites/universes";

// Fictional sites for the design preview (/apercu/mini-site), shaped
// exactly like saved configurations, WITHOUT photos: what a professional's
// site looks like before she adds hers (the demo photos of the universes
// are never saved nor published, docs/SITE_PUBLISHING_CONTRACT.md § 10).

const texts: Record<
  UniverseId,
  Pick<SiteConfig, "brand"> & {
    works: { title: string; note: string }[];
    portrait: { name: string; role: string; text: string };
  }
> = {
  mila: {
    brand: {
      name: "Studio Mila",
      kind: "Cils & regard",
      location: "Paris 9e",
      intro:
        "Un regard se dessine comme une silhouette. Extensions, rehaussement et sourcils, pensés comme une ligne de collection.",
    },
    works: [
      { title: "Volume russe", note: "Effet œil de biche, 2 h 30" },
      { title: "La pose", note: "Cil à cil, au studio" },
      { title: "Cil à cil", note: "Naturel, courbure C" },
    ],
    portrait: {
      name: "Mila",
      role: "Technicienne cils · fondatrice",
      text: "Je travaille seule, une cliente à la fois. Chaque pose commence par regarder votre œil, pas par choisir un modèle.",
    },
  },
  alma: {
    brand: {
      name: "Maison Alma",
      kind: "Soins du regard & rituels",
      location: "Lyon 2e",
      intro:
        "Un lieu pour ralentir. Chaque soin commence par quelques minutes de silence, et se termine quand vous êtes prête.",
    },
    works: [
      { title: "Le geste", note: "Pose lente, cil après cil" },
      { title: "Cils au naturel", note: "Une pose qui ne se voit pas" },
      { title: "Matière", note: "Nos cils, un par un" },
    ],
    portrait: {
      name: "Alma",
      role: "Praticienne du regard",
      text: "J'ai ouvert la maison pour prendre le temps. Ici, on parle peu, on respire, et vous repartez avec votre propre regard.",
    },
  },
  "nail-lab": {
    brand: {
      name: "Nail Lab",
      kind: "Ongles & nail art",
      location: "Marseille 6e",
      intro:
        "Ongles construits, nail art à main levée. On vient avec une idée, on repart avec une pièce.",
    },
    works: [
      { title: "Léopard", note: "Gel, main levée" },
      { title: "Marine & or", note: "Construction, 2 h" },
      { title: "Chrome doré", note: "Amande, poudre miroir" },
    ],
    portrait: {
      name: "Nina",
      role: "Prothésiste ongulaire",
      text: "Couleurs franches, formes nettes, zéro compromis sur la tenue. Ramenez une idée, on la dessine ensemble.",
    },
  },
};

/** A saved configuration of this universe, without any photo. */
export function sampleSite(universe: UniverseId): SiteConfig {
  const design = universeDesigns[universe];
  const { brand, portrait } = texts[universe];
  return {
    universe,
    brand,
    content: {
      cover: null,
      // Works need a photo to be saved: without photos, she has none yet.
      works: [],
      portrait: { photo: null, ...portrait },
      focals: {},
    },
    tokens: { ...design.tokens },
    sections: design.sections,
    booking: design.booking,
    quickBook: design.quickBook,
  };
}

/** Its works' words, to preview a gallery whose photos were withdrawn. */
export const sampleWorks = (universe: UniverseId) => texts[universe].works;

/** A catalogue as get_public_catalog projects it, with options. */
export const sampleCatalog: PublicCatalog = {
  currency: "EUR",
  groups: [
    {
      category: { id: "c-regard", name: "Regard" },
      services: [
        {
          id: "s1",
          name: "Volume russe",
          description: "Une pose dense et légère, effet œil de biche.",
          durationMinutes: 150,
          priceCents: 9500,
          options: [
            {
              id: "o1",
              question: "Dépose de l’ancienne pose ?",
              required: false,
              choices: [
                {
                  id: "o1c1",
                  label: "Oui",
                  priceDeltaCents: 1000,
                  durationDeltaMinutes: 15,
                },
              ],
            },
          ],
        },
        {
          id: "s2",
          name: "Rehaussement de cils",
          description: "Vos cils, courbés et teintés. Rien d’ajouté.",
          durationMinutes: 60,
          priceCents: 6000,
          options: [],
        },
      ],
    },
    {
      category: null,
      services: [
        {
          id: "s3",
          name: "Restructuration sourcils",
          description: null,
          durationMinutes: 45,
          priceCents: 3500,
          options: [],
        },
      ],
    },
  ],
};
