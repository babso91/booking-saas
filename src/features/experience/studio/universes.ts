import { universeDesigns, type UniverseId } from "@/features/sites/universes";

import type { Palette, SiteConfig } from "../engine/config";
import { demo } from "./photos";

// The universes as her studio shows them. Their design (palettes, type,
// grade, motion, shape, composition) is the ONE shared copy
// (src/features/sites/universes.ts: the server checks readability with it,
// the public page renders with it). What is here is only what a studio
// needs on top: the demo content of each universe (its texts, and demo
// photos that are never saved nor published), and a Signature inspiration.
// From the Experience Engine lab (proto/experience-engine, universes.ts).

export type { UniverseId };

type Demo = {
  brand: SiteConfig["brand"];
  content: SiteConfig["content"];
  /** A Signature recomposition, to show what the studio unlocks. */
  signature?: { name: string; apply: (config: SiteConfig) => SiteConfig };
};

export type Universe = {
  id: UniverseId;
  /** Our designed starting point, with its demo content. */
  config: SiteConfig;
  /** Palettes designed for this universe (Core picks among them). */
  palettes: { name: string; palette: Palette }[];
  signature?: Demo["signature"];
};

const milaDemo: Demo = {
  brand: {
    name: "Studio Mila",
    kind: "Cils & regard",
    location: "Paris 9e",
    intro:
      "Un regard se dessine comme une silhouette. Extensions, rehaussement et sourcils, pensés comme une ligne de collection.",
  },
  content: {
    cover: demo("1548902378-2ec44c906391"),
    works: [
      {
        id: "w1",
        photo: demo("1639629509821-c54cdd984227"),
        title: "Volume russe",
        note: "Effet œil de biche, 2 h 30",
      },
      {
        id: "w2",
        photo: demo("1589710751893-f9a6770ad71b"),
        title: "La pose",
        note: "Cil à cil, au studio",
      },
      {
        id: "w3",
        photo: demo("1567629307995-b9f33097bd30"),
        title: "Cil à cil",
        note: "Naturel, courbure C",
      },
      {
        id: "w4",
        photo: demo("1674049406467-824ea37c7184"),
        title: "Rehaussement",
        note: "Courbe et teinture, 1 h",
      },
      {
        id: "w5",
        photo: demo("1674049406179-d7bf2c263e71"),
        title: "Sourcils",
        note: "Restructuration, 45 min",
      },
    ],
    portrait: {
      photo: demo("1772235616130-b80e12f0ab7a"),
      name: "Mila",
      role: "Technicienne cils · fondatrice",
      text: "Je travaille seule, une cliente à la fois. Chaque pose commence par regarder votre œil, pas par choisir un modèle.",
    },
    focals: {},
  },
  signature: {
    name: "Mila · Nocturne",
    apply: (config) => ({
      ...config,
      tokens: {
        palette: {
          bg: "#170709",
          ink: "#F3E9E4",
          paper: "#F3E9E4",
          inkOnPaper: "#170709",
          muted: "#A08A8C",
          line: "#3A1D22",
          accent: "#E8462A",
          onAccent: "#170709",
        },
        type: "didone",
        grade: "chrome",
        motion: "settle",
        shape: "soft",
      },
      sections: [
        { kind: "opening", variant: "bloom" },
        { kind: "work", variant: "filmstrip" },
        { kind: "intro", variant: "lines" },
        { kind: "portrait", variant: "arch" },
        { kind: "services", variant: "tiles" },
      ],
      booking: "sheet",
      quickBook: "pill",
    }),
  },
};

const almaDemo: Demo = {
  brand: {
    name: "Maison Alma",
    kind: "Soins du regard & rituels",
    location: "Lyon 2e",
    intro:
      "Un lieu pour ralentir. Chaque soin commence par quelques minutes de silence, et se termine quand vous êtes prête.",
  },
  content: {
    cover: demo("1777262080995-da4a45f51af8"),
    works: [
      {
        id: "w1",
        photo: demo("1772236617396-2f8460293c07"),
        title: "Le geste",
        note: "Pose lente, cil après cil",
      },
      {
        id: "w2",
        photo: demo("1639629509821-c54cdd984227"),
        title: "Cils au naturel",
        note: "Une pose qui ne se voit pas",
      },
      {
        id: "w3",
        photo: demo("1770999086860-143f54adf01b"),
        title: "Matière",
        note: "Nos cils, un par un",
      },
      {
        id: "w4",
        photo: demo("1772235616130-b80e12f0ab7a"),
        title: "Rituel regard",
        note: "Rehaussement et soin",
      },
      {
        id: "w5",
        photo: demo("1674049406179-d7bf2c263e71"),
        title: "Sourcils",
        note: "Dessinés au fil",
      },
    ],
    portrait: {
      photo: demo("1772236617396-2f8460293c07"),
      name: "Alma",
      role: "Praticienne du regard",
      text: "J'ai ouvert la maison pour prendre le temps. Ici, on parle peu, on respire, et vous repartez avec votre propre regard.",
    },
    focals: {},
  },
};

const nailLabDemo: Demo = {
  brand: {
    name: "Nail Lab",
    kind: "Ongles & nail art",
    location: "Marseille 6e",
    intro:
      "Ongles construits, nail art à main levée. On vient avec une idée, on repart avec une pièce.",
  },
  content: {
    cover: demo("1777287216954-2b4b22bb6bf2"),
    works: [
      {
        id: "w1",
        photo: demo("1777288390469-828f8816231c"),
        title: "Léopard",
        note: "Gel, main levée",
      },
      {
        id: "w2",
        photo: demo("1754799670312-8e7da8e40ad7"),
        title: "Marine & or",
        note: "Construction, 2 h",
      },
      {
        id: "w3",
        photo: demo("1604654894610-df63bc536371"),
        title: "Écaille",
        note: "Semi-permanent",
      },
      {
        id: "w4",
        photo: demo("1770210257340-dc2b0f44642a"),
        title: "Chrome doré",
        note: "Amande, poudre miroir",
      },
      {
        id: "w5",
        photo: demo("1607779097040-26e80aa78e66"),
        title: "Givre",
        note: "Paillettes, babyboomer",
      },
    ],
    portrait: {
      photo: demo("1632345031435-8727f6897d53"),
      name: "Nina",
      role: "Prothésiste ongulaire",
      text: "Couleurs franches, formes nettes, zéro compromis sur la tenue. Ramenez une idée, on la dessine ensemble.",
    },
    focals: {},
  },
};

function universe(id: UniverseId, content: Demo): Universe {
  const design = universeDesigns[id];
  return {
    id,
    config: {
      universe: id,
      brand: content.brand,
      content: content.content,
      tokens: { ...design.tokens },
      sections: design.sections,
      booking: design.booking,
      quickBook: design.quickBook,
    },
    palettes: design.palettes,
    signature: content.signature,
  };
}

export const universes: Record<UniverseId, Universe> = {
  mila: universe("mila", milaDemo),
  alma: universe("alma", almaDemo),
  "nail-lab": universe("nail-lab", nailLabDemo),
};
