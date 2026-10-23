import type { Palette, SiteConfig } from "./engine/config";

// The universes we design. Each is a SiteConfig plus the palettes a Core
// professional may choose from; Nail Lab has no code of its own: it is
// only configuration of the shared scene library.

export type UniverseId = "mila" | "alma" | "nail-lab";

export type Universe = {
  id: UniverseId;
  /** Our designed starting point. */
  config: SiteConfig;
  /** Palettes designed for this universe (Core picks among them). */
  palettes: { name: string; palette: Palette }[];
  /** A Signature recomposition, to show what the studio unlocks. */
  signature?: { name: string; apply: (config: SiteConfig) => SiteConfig };
};

const milaInk: Palette = {
  bg: "#0B0B0B",
  ink: "#F2F0EC",
  paper: "#F2F0EC",
  inkOnPaper: "#0B0B0B",
  muted: "#8B8883",
  line: "#2A2927",
  accent: "#FF3B1F",
  onAccent: "#0B0B0B",
};

export const mila: Universe = {
  id: "mila",
  config: {
    universe: "mila",
    brand: {
      name: "Studio Mila",
      kind: "Cils & regard",
      location: "Paris 9e",
      intro:
        "Un regard se dessine comme une silhouette. Extensions, rehaussement et sourcils, pensés comme une ligne de collection.",
    },
    content: {
      cover: "1548902378-2ec44c906391",
      works: [
        {
          id: "w1",
          photo: "1639629509821-c54cdd984227",
          title: "Volume russe",
          note: "Effet œil de biche, 2 h 30",
        },
        {
          id: "w2",
          photo: "1589710751893-f9a6770ad71b",
          title: "La pose",
          note: "Cil à cil, au studio",
        },
        {
          id: "w3",
          photo: "1567629307995-b9f33097bd30",
          title: "Cil à cil",
          note: "Naturel, courbure C",
        },
        {
          id: "w4",
          photo: "1674049406467-824ea37c7184",
          title: "Rehaussement",
          note: "Courbe et teinture, 1 h",
        },
        {
          id: "w5",
          photo: "1674049406179-d7bf2c263e71",
          title: "Sourcils",
          note: "Restructuration, 45 min",
        },
      ],
      services: [
        {
          id: "s1",
          name: "Pose cil à cil",
          durationMinutes: 120,
          priceCents: 9000,
          blurb:
            "Une extension par cil naturel, pour une densité qui ne se voit pas.",
        },
        {
          id: "s2",
          name: "Volume russe",
          durationMinutes: 150,
          priceCents: 12000,
          blurb: "Bouquets ultra-fins, regard intense, tenue quatre semaines.",
        },
        {
          id: "s3",
          name: "Rehaussement de cils",
          durationMinutes: 60,
          priceCents: 6500,
          blurb: "Vos cils, courbés et teintés. Rien d'ajouté.",
        },
        {
          id: "s4",
          name: "Restructuration sourcils",
          durationMinutes: 45,
          priceCents: 4500,
          blurb: "Ligne, épaisseur, teinte : un dessin à votre visage.",
        },
      ],
    },
    tokens: {
      palette: milaInk,
      type: "didone",
      grade: "silver",
      motion: "cut",
      shape: "sharp",
    },
    sections: [
      { kind: "opening", variant: "didone-cut" },
      { kind: "intro", variant: "statement" },
      { kind: "work", variant: "lookbook" },
      { kind: "services", variant: "index" },
    ],
    booking: "page",
    quickBook: "bar",
  },
  palettes: [
    { name: "Encre", palette: milaInk },
    {
      name: "Papier",
      palette: {
        ...milaInk,
        bg: "#ECEAE4",
        ink: "#0B0B0B",
        paper: "#0B0B0B",
        inkOnPaper: "#ECEAE4",
        muted: "#6E6B66",
        line: "#CFCBC2",
      },
    },
    {
      name: "Bordeaux",
      palette: {
        ...milaInk,
        bg: "#1C0A0E",
        line: "#3A1D22",
        accent: "#F2C14E",
        muted: "#9C8487",
      },
    },
  ],
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
        { kind: "services", variant: "tiles" },
      ],
      booking: "sheet",
      quickBook: "pill",
    }),
  },
};

const almaOlive: Palette = {
  bg: "#1E2620",
  ink: "#E9ECE3",
  paper: "#DCE2D4",
  inkOnPaper: "#1E2620",
  muted: "#97A08F",
  line: "#34403A",
  accent: "#D2795A",
  onAccent: "#FFFFFF",
};

export const alma: Universe = {
  id: "alma",
  config: {
    universe: "alma",
    brand: {
      name: "Maison Alma",
      kind: "Soins du regard & rituels",
      location: "Lyon 2e",
      intro:
        "Un lieu pour ralentir. Chaque soin commence par quelques minutes de silence, et se termine quand vous êtes prête.",
    },
    content: {
      cover: "1777262080995-da4a45f51af8",
      works: [
        {
          id: "w1",
          photo: "1772236617396-2f8460293c07",
          title: "Le geste",
          note: "Pose lente, cil après cil",
        },
        {
          id: "w2",
          photo: "1639629509821-c54cdd984227",
          title: "Cils au naturel",
          note: "Une pose qui ne se voit pas",
        },
        {
          id: "w3",
          photo: "1770999086860-143f54adf01b",
          title: "Matière",
          note: "Nos cils, un par un",
        },
        {
          id: "w4",
          photo: "1772235616130-b80e12f0ab7a",
          title: "Rituel regard",
          note: "Rehaussement et soin",
        },
        {
          id: "w5",
          photo: "1674049406179-d7bf2c263e71",
          title: "Sourcils",
          note: "Dessinés au fil",
        },
      ],
      services: [
        {
          id: "s1",
          name: "Rituel regard",
          durationMinutes: 75,
          priceCents: 7800,
          blurb: "Rehaussement, teinture et massage du contour de l'œil.",
        },
        {
          id: "s2",
          name: "Cils au naturel",
          durationMinutes: 120,
          priceCents: 9500,
          blurb: "Une pose légère, invisible, qui suit vos propres cils.",
        },
        {
          id: "s3",
          name: "Sourcils au fil",
          durationMinutes: 40,
          priceCents: 3800,
          blurb: "Une ligne nette, sans rougeur, à la main.",
        },
      ],
    },
    tokens: {
      palette: almaOlive,
      type: "soft-serif",
      grade: "warm",
      motion: "settle",
      shape: "soft",
    },
    sections: [
      { kind: "opening", variant: "bloom" },
      { kind: "intro", variant: "lines" },
      { kind: "work", variant: "arches" },
      { kind: "services", variant: "shelf" },
    ],
    booking: "sheet",
    quickBook: "pill",
  },
  palettes: [
    { name: "Olive", palette: almaOlive },
    {
      name: "Brume",
      palette: {
        ...almaOlive,
        bg: "#2E333B",
        ink: "#E7EAEE",
        paper: "#E2E5E9",
        inkOnPaper: "#2E333B",
        muted: "#9AA1AB",
        line: "#424852",
        accent: "#C98A6B",
      },
    },
    {
      name: "Argile",
      palette: {
        ...almaOlive,
        bg: "#3A2923",
        ink: "#F1E7DF",
        paper: "#EFE4DA",
        inkOnPaper: "#3A2923",
        muted: "#B39F92",
        line: "#55413A",
        accent: "#8FA77F",
        onAccent: "#1E2620",
      },
    },
  ],
};

const nailCobalt: Palette = {
  bg: "#0E0E10",
  ink: "#F4F4F0",
  paper: "#F1F0EA",
  inkOnPaper: "#0E0E10",
  muted: "#8E8E96",
  line: "#2A2A30",
  accent: "#2B3BFF",
  onAccent: "#F4F4F0",
};

/** Configuration only: no Nail Lab code exists anywhere. */
export const nailLab: Universe = {
  id: "nail-lab",
  config: {
    universe: "nail-lab",
    brand: {
      name: "Nail Lab",
      kind: "Ongles & nail art",
      location: "Marseille 6e",
      intro:
        "Ongles construits, nail art à main levée. On vient avec une idée, on repart avec une pièce.",
    },
    content: {
      cover: "1777287216954-2b4b22bb6bf2",
      works: [
        {
          id: "w1",
          photo: "1777288390469-828f8816231c",
          title: "Léopard",
          note: "Gel, main levée",
        },
        {
          id: "w2",
          photo: "1754799670312-8e7da8e40ad7",
          title: "Marine & or",
          note: "Construction, 2 h",
        },
        {
          id: "w3",
          photo: "1604654894610-df63bc536371",
          title: "Écaille",
          note: "Semi-permanent",
        },
        {
          id: "w4",
          photo: "1770210257340-dc2b0f44642a",
          title: "Chrome doré",
          note: "Amande, poudre miroir",
        },
        {
          id: "w5",
          photo: "1607779097040-26e80aa78e66",
          title: "Givre",
          note: "Paillettes, babyboomer",
        },
      ],
      services: [
        {
          id: "s1",
          name: "Semi-permanent",
          durationMinutes: 60,
          priceCents: 3500,
          blurb: "Couleur unie, tenue trois semaines.",
        },
        {
          id: "s2",
          name: "Construction gel",
          durationMinutes: 120,
          priceCents: 6500,
          blurb: "Forme sur mesure : amande, coffin, stiletto.",
        },
        {
          id: "s3",
          name: "Nail art",
          durationMinutes: 30,
          priceCents: 2000,
          blurb: "Par main. Apportez votre idée, on la dessine.",
        },
        {
          id: "s4",
          name: "Dépose + soin",
          durationMinutes: 45,
          priceCents: 2500,
          blurb: "Dépose douce et soin des cuticules.",
        },
      ],
    },
    tokens: {
      palette: nailCobalt,
      type: "condensed",
      grade: "chrome",
      motion: "snap",
      shape: "round",
    },
    sections: [
      { kind: "opening", variant: "kinetic" },
      { kind: "work", variant: "filmstrip" },
      { kind: "intro", variant: "statement" },
      { kind: "services", variant: "tiles" },
    ],
    booking: "sheet",
    quickBook: "pill",
  },
  palettes: [
    { name: "Cobalt", palette: nailCobalt },
    {
      name: "Cerise",
      palette: { ...nailCobalt, accent: "#FF2D55", onAccent: "#0E0E10" },
    },
    {
      name: "Acide",
      palette: { ...nailCobalt, accent: "#D4FF00", onAccent: "#0E0E10" },
    },
  ],
};

export const universes: Record<UniverseId, Universe> = {
  mila,
  alma,
  "nail-lab": nailLab,
};
