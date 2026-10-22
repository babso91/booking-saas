import type { ClientHubLoyaltyDto } from "@/features/client-hub/types";

// Experience lab (prototype, never deployed): one functional model, several
// "universes". A universe is configuration — identity, palette, type,
// photography, motion language and the composition each scene uses — never
// a separate app. Data is fictional and shaped like the real DTOs, so the
// scenes could be fed by the real routes later.

export type Work = { id: string; photo: string; title: string; note: string };

export type Service = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  blurb: string;
};

export type Universe = {
  id: "mila" | "alma";
  name: string;
  kind: string;
  location: string;
  intro: string;
  cover: string;
  works: Work[];
  services: Service[];
  loyalty: ClientHubLoyaltyDto;
  /** CSS variables of the universe (colors), applied on its root. */
  palette: Record<string, string>;
  /** Font CSS variables (from next/font) used by the universe. */
  fonts: { display: string; body: string; detail: string };
  /** Motion language. */
  motion: {
    ease: [number, number, number, number];
    /** Seconds of a scene transition. */
    scene: number;
    /** How the brand is entered from the hub. */
    entrance: "cut" | "bloom";
  };
};

/** An Unsplash photo by id, cropped and compressed by their CDN. */
export const photo = (id: string, width: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${width}&q=72`;

export const srcSet = (id: string) =>
  [480, 828, 1200].map((width) => `${photo(id, width)} ${width}w`).join(", ");

const loyalty = (balance: number): ClientHubLoyaltyDto => ({
  programActive: true,
  balance,
  rewards: [
    {
      id: "r1",
      name: "Soin des cils offert",
      description: null,
      pointsRequired: 300,
      rewardType: "free_service",
      rewardValue: null,
      currency: null,
      serviceName: "Soin des cils",
      eligible: balance >= 300,
      missingPoints: Math.max(0, 300 - balance),
    },
    {
      id: "r2",
      name: "Remise de 15 €",
      description: null,
      pointsRequired: 400,
      rewardType: "fixed_discount",
      rewardValue: 1500,
      currency: "EUR",
      serviceName: null,
      eligible: balance >= 400,
      missingPoints: Math.max(0, 400 - balance),
    },
    {
      id: "r3",
      name: "Pose offerte",
      description: null,
      pointsRequired: 1000,
      rewardType: "free_service",
      rewardValue: null,
      currency: null,
      serviceName: "Pose cil à cil",
      eligible: balance >= 1000,
      missingPoints: Math.max(0, 1000 - balance),
    },
  ],
  issuedRewards: [],
});

export const mila: Universe = {
  id: "mila",
  name: "Studio Mila",
  kind: "Cils & regard",
  location: "Paris 9e",
  intro:
    "Un regard se dessine comme une silhouette. Extensions, rehaussement et sourcils, pensés comme une ligne de collection.",
  cover: "1633381521050-26bb467d9d5a",
  works: [
    {
      id: "w1",
      photo: "1639629509821-c54cdd984227",
      title: "Volume russe",
      note: "Effet œil de biche, 2 h",
    },
    {
      id: "w2",
      photo: "1548902378-2ec44c906391",
      title: "Cil à cil",
      note: "Naturel, courbure C",
    },
    {
      id: "w3",
      photo: "1533392151650-269f96231f65",
      title: "Regard nu",
      note: "Rehaussement + teinture",
    },
    {
      id: "w4",
      photo: "1567629307995-b9f33097bd30",
      title: "Mascara permanent",
      note: "Tenue 6 semaines",
    },
    {
      id: "w5",
      photo: "1606143412458-acc5f86de897",
      title: "Ligne graphique",
      note: "Sourcils restructurés",
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
  loyalty: loyalty(340),
  palette: {
    "--u-bg": "#0B0B0B",
    "--u-paper": "#F2F0EC",
    "--u-ink": "#F2F0EC",
    "--u-ink-on-paper": "#0B0B0B",
    "--u-muted": "#8B8883",
    "--u-line": "#2A2927",
    "--u-accent": "#FF3B1F",
  },
  fonts: {
    display: "var(--font-mila-display)",
    body: "var(--font-mila-body)",
    detail: "var(--font-mila-mono)",
  },
  motion: { ease: [0.76, 0, 0.24, 1], scene: 0.7, entrance: "cut" },
};

export const alma: Universe = {
  id: "alma",
  name: "Maison Alma",
  kind: "Soins du regard & rituels",
  location: "Lyon 2e",
  intro:
    "Un lieu pour ralentir. Chaque soin commence par quelques minutes de silence, et se termine quand vous êtes prête.",
  cover: "1789454715591-dc406c8f6ede",
  works: [
    {
      id: "w1",
      photo: "1777262080995-da4a45f51af8",
      title: "Cils au naturel",
      note: "Rehaussement doux",
    },
    {
      id: "w2",
      photo: "1710580889701-9fa8f2cd5927",
      title: "Matière",
      note: "La peau, avant tout",
    },
    {
      id: "w3",
      photo: "1772236617396-2f8460293c07",
      title: "Le geste",
      note: "Pose lente, cil après cil",
    },
    {
      id: "w4",
      photo: "1773062974528-f78d2cc8e695",
      title: "Lumière",
      note: "La cabine du matin",
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
  loyalty: loyalty(180),
  palette: {
    "--u-bg": "#1E2620",
    "--u-paper": "#DCE2D4",
    "--u-ink": "#E9ECE3",
    "--u-ink-on-paper": "#1E2620",
    "--u-muted": "#97A08F",
    "--u-line": "#34403A",
    "--u-accent": "#D2795A",
  },
  fonts: {
    display: "var(--font-alma-display)",
    body: "var(--font-alma-body)",
    detail: "var(--font-alma-body)",
  },
  motion: { ease: [0.22, 1, 0.36, 1], scene: 1.2, entrance: "bloom" },
};

export const universes = { mila, alma } as const;

/** Bookable days and slots (fictional). */
export function slotsFor(day: number) {
  const base = ["09:30", "10:00", "11:30", "13:00", "14:30", "16:00", "17:30"];
  return base.filter((_, index) => (index + day) % 3 !== 0);
}
