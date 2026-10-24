// FICTITIOUS professionals, used only to stress-test the experience engine
// (a short catalogue, a very long one, odd durations, hidden or empty
// categories, options). Every brand, text and price below is invented: none
// of it describes a real business or a real tariff, and none of it must be
// presented as such. Do not add real names or real prices here.

import type { Portrait, SiteConfig } from "../engine/config";
import type { Catalog, CatalogService, ServiceOption } from "./model";

export type ProId = "cils" | "henne" | "epilation";

export type Pro = {
  id: ProId;
  /** Short label for the lab's switcher. */
  label: string;
  brand: SiteConfig["brand"];
  /** Her portrait's words (the photo stays the universe's example). */
  portrait: Omit<Portrait, "photo">;
  catalog: Catalog;
};

// --- Small builders, so the data below stays readable ------------------------

const category = (id: string, name: string, visible = true) => ({
  id,
  name,
  visible,
});

const service = (
  id: string,
  categoryId: string | null,
  name: string,
  durationMinutes: number,
  priceCents: number,
  description = "",
  extra: { active?: boolean; options?: ServiceOption[] } = {},
): CatalogService => ({
  id,
  categoryId,
  name,
  description,
  durationMinutes,
  priceCents,
  active: extra.active ?? true,
  options: extra.options ?? [],
});

const choice = (
  id: string,
  label: string,
  priceDeltaCents = 0,
  durationDeltaMinutes = 0,
) => ({ id, label, priceDeltaCents, durationDeltaMinutes });

/** "Non" / "Oui" with a supplement on "Oui". */
const yesNo = (
  id: string,
  question: string,
  priceDeltaCents: number,
  durationDeltaMinutes = 0,
): ServiceOption => ({
  id,
  question,
  choices: [
    choice(`${id}-non`, "Non"),
    choice(`${id}-oui`, "Oui", priceDeltaCents, durationDeltaMinutes),
  ],
});

// --- Cils: a few categories, one hidden, one empty, one inactive service -----

const cils: Pro = {
  id: "cils",
  label: "Technicienne cils",
  portrait: {
    name: "Prénom Exemple",
    role: "Technicienne cils",
    text: "Texte d’exemple : ici, la professionnelle se présente avec ses mots, son parcours et sa façon de travailler.",
  },
  brand: {
    name: "Atelier Cilia Test",
    kind: "Extensions de cils",
    location: "Ville-Exemple",
    intro:
      "Un exemple fictif de technicienne cils, pour éprouver le moteur : rien ici n’est réel.",
  },
  catalog: {
    categories: [
      category("cils-ext", "Extensions"),
      category("cils-rem", "Remplissages"),
      category("cils-reh", "Rehaussement"),
      category("cils-form", "Formations", false),
      category("cils-new", "Nouveautés"),
    ],
    services: [
      service(
        "cils-s1",
        "cils-ext",
        "Pose cil à cil",
        120,
        2200,
        "Une extension par cil naturel, pour une densité discrète.",
      ),
      service(
        "cils-s2",
        "cils-ext",
        "Volume russe",
        150,
        2500,
        "Bouquets ultra-fins, regard intense.",
        {
          options: [
            yesNo("cils-depose", "Avez-vous besoin d’une dépose ?", 500),
          ],
        },
      ),
      service(
        "cils-s3",
        "cils-ext",
        "Volume mega",
        180,
        3000,
        "Un regard très dense, pour les soirs de fête.",
      ),
      service(
        "cils-s4",
        "cils-ext",
        "Effet naturel express",
        75,
        1800,
        "Une pose courte, sur la partie extérieure du regard.",
        { active: false },
      ),
      service(
        "cils-s5",
        "cils-rem",
        "Remplissage cil à cil",
        75,
        1500,
        "À faire dans les trois semaines suivant la pose.",
        {
          options: [
            yesNo(
              "cils-retard",
              "Votre dernière pose date de plus de trois semaines ?",
              1000,
              15,
            ),
          ],
        },
      ),
      service(
        "cils-s6",
        "cils-rem",
        "Remplissage volume",
        90,
        1800,
        "Pour entretenir une pose en volume.",
      ),
      service(
        "cils-s7",
        "cils-reh",
        "Rehaussement de cils",
        60,
        1000,
        "Vos cils, courbés et teintés. Rien d’ajouté.",
      ),
      service(
        "cils-s8",
        "cils-reh",
        "Rehaussement et teinture",
        75,
        1250,
        "Courbe et couleur, en une seule séance.",
      ),
      service(
        "cils-s9",
        "cils-reh",
        "Teinture des sourcils",
        20,
        500,
        "Une teinte douce pour structurer le regard.",
      ),
      service(
        "cils-s10",
        "cils-form",
        "Initiation à la pose (journée)",
        480,
        9000,
        "Formation fictive, réservée aux professionnelles.",
      ),
    ],
  },
};

// --- Henné: two neutral categories, one loose service, extreme durations -----

const henne: Pro = {
  id: "henne",
  label: "Artiste henné",
  portrait: {
    name: "Prénom Exemple",
    role: "Artiste henné",
    text: "Texte d’exemple : ici, l’artiste raconte ce qu’elle aime dessiner et comment se passe une séance.",
  },
  brand: {
    name: "Maison Tracé Fictif",
    kind: "Henné",
    location: "Ville-Exemple",
    intro:
      "Un exemple fictif d’artiste, pour éprouver le moteur : rien ici n’est réel.",
  },
  catalog: {
    categories: [
      category("he-petits", "Petits motifs"),
      category("he-grands", "Grandes compositions"),
    ],
    services: [
      service(
        "he-p1",
        "he-petits",
        "Un doigt",
        15,
        500,
        "Un motif minuscule, en quelques minutes.",
      ),
      service(
        "he-p2",
        "he-petits",
        "Poignet ou cheville",
        30,
        1200,
        "Un bracelet dessiné, d’un seul trait.",
        {
          options: [
            {
              id: "he-personnes",
              question: "Pour combien de personnes ?",
              choices: [
                choice("he-pers-1", "1 personne"),
                choice("he-pers-2", "2 personnes", 1000, 25),
                choice("he-pers-3", "3 personnes", 1900, 50),
              ],
            },
          ],
        },
      ),
      service(
        "he-p3",
        "he-petits",
        "Dos de la main",
        45,
        1800,
        "Une composition légère sur le dessus de la main.",
      ),
      service(
        "he-g1",
        "he-grands",
        "Main et avant-bras",
        120,
        4500,
        "Un motif qui remonte jusqu’au coude.",
      ),
      service(
        "he-g2",
        "he-grands",
        "Composition complète des deux mains et des avant-bras avec finitions et séchage accompagné",
        360,
        18000,
        "La séance la plus longue : prévoyez une demi-journée.",
      ),
      service(
        "he-g3",
        "he-grands",
        "Dos entier",
        240,
        12000,
        "Une grande pièce, dessinée à main levée.",
      ),
      service(
        "he-x1",
        null,
        "Essai de motif",
        20,
        0,
        "Un petit test, gratuit, avant de choisir.",
      ),
    ],
  },
};

// --- Épilation: a long catalogue, many categories --------------------------

const epilation: Pro = {
  id: "epilation",
  label: "Institut épilation",
  portrait: {
    name: "Prénom Exemple",
    role: "Esthéticienne",
    text: "Texte d’exemple : ici, l’esthéticienne explique sa méthode, ses produits et ce qui rassure ses clientes.",
  },
  brand: {
    name: "Institut Lisse Imaginaire",
    kind: "Épilation",
    location: "Ville-Exemple",
    intro:
      "Un exemple fictif d’institut, pour éprouver le moteur : rien ici n’est réel.",
  },
  catalog: {
    categories: [
      category("ep-visage", "Visage"),
      category("ep-sourcils", "Sourcils"),
      category("ep-aisselles", "Aisselles"),
      category("ep-bras", "Bras"),
      category("ep-mains", "Mains et pieds"),
      category("ep-jambes", "Jambes"),
      category("ep-cuisses", "Cuisses"),
      category("ep-maillot", "Maillot"),
      category("ep-fesses", "Fesses"),
      category("ep-dos", "Dos"),
      category("ep-torse", "Torse"),
      category("ep-ventre", "Ventre"),
      category("ep-forfaits", "Forfaits"),
      category("ep-combos", "Combinaisons de zones et formules du moment"),
      category("ep-pro", "Tarifs partenaires", false),
      category("ep-new", "Nouveautés"),
    ],
    services: [
      service("ep-visage-1", "ep-visage", "Lèvre supérieure", 10, 700),
      service("ep-visage-2", "ep-visage", "Menton", 10, 700),
      service("ep-visage-3", "ep-visage", "Visage entier", 30, 1900, "", {
        options: [
          yesNo(
            "ep-apaisant",
            "Souhaitez-vous un soin apaisant après l’épilation ?",
            800,
            10,
          ),
        ],
      }),
      service("ep-sourcils-1", "ep-sourcils", "Sourcils", 15, 900),
      service("ep-sourcils-2", "ep-sourcils", "Restructuration", 25, 1250),
      service("ep-aisselles-1", "ep-aisselles", "Aisselles", 15, 1000),
      service("ep-bras-1", "ep-bras", "Demi-bras", 20, 1250),
      service("ep-bras-2", "ep-bras", "Bras entiers", 30, 1850),
      service("ep-mains-1", "ep-mains", "Doigts", 10, 500),
      service("ep-mains-2", "ep-mains", "Orteils", 10, 500),
      service("ep-jambes-1", "ep-jambes", "Demi-jambes", 30, 1650),
      service("ep-jambes-2", "ep-jambes", "Jambes entières", 50, 2650),
      service("ep-jambes-3", "ep-jambes", "Genoux", 10, 600, "", {
        active: false,
      }),
      service("ep-cuisses-1", "ep-cuisses", "Cuisses", 30, 1900),
      service("ep-maillot-1", "ep-maillot", "Maillot classique", 15, 1200),
      service("ep-maillot-2", "ep-maillot", "Maillot échancré", 20, 1550),
      service("ep-maillot-3", "ep-maillot", "Maillot intégral", 30, 2250),
      service("ep-fesses-1", "ep-fesses", "Sillon interfessier", 10, 800),
      service("ep-fesses-2", "ep-fesses", "Fesses entières", 20, 1400),
      service("ep-dos-1", "ep-dos", "Demi-dos", 25, 2000),
      service("ep-dos-2", "ep-dos", "Dos entier", 45, 3200),
      service("ep-dos-3", "ep-dos", "Épaules", 15, 1100, "", { active: false }),
      service("ep-torse-1", "ep-torse", "Torse", 40, 3000),
      service("ep-torse-2", "ep-torse", "Pectoraux", 25, 2100),
      service("ep-ventre-1", "ep-ventre", "Ligne du ventre", 10, 800),
      service("ep-ventre-2", "ep-ventre", "Ventre entier", 25, 1800),
      service(
        "ep-forfaits-1",
        "ep-forfaits",
        "Forfait jambes et aisselles",
        60,
        3300,
      ),
      service(
        "ep-forfaits-2",
        "ep-forfaits",
        "Forfait jambes, maillot, aisselles",
        80,
        4600,
      ),
      service(
        "ep-forfaits-3",
        "ep-forfaits",
        "Forfait corps complet",
        150,
        9000,
        "",
        {
          options: [
            yesNo(
              "ep-apaisant-corps",
              "Souhaitez-vous un soin apaisant ?",
              800,
              10,
            ),
          ],
        },
      ),
      service(
        "ep-forfaits-4",
        "ep-forfaits",
        "Forfait visage complet",
        40,
        2400,
        "",
        {
          active: false,
        },
      ),
      service("ep-combos-1", "ep-combos", "Sourcils et lèvre", 20, 1400),
      service("ep-combos-2", "ep-combos", "Maillot et aisselles", 30, 2100),
      service("ep-combos-3", "ep-combos", "Demi-jambes et maillot", 45, 2700),
      service("ep-combos-4", "ep-combos", "Bras et aisselles", 40, 2500),
      service(
        "ep-pro-1",
        "ep-pro",
        "Tarif partenaire : jambes entières",
        50,
        2000,
      ),
      service("ep-pro-2", "ep-pro", "Tarif partenaire : maillot", 20, 1000),
    ],
  },
};

export const pros: Record<ProId, Pro> = { cils, henne, epilation };

export const isProId = (value: unknown): value is ProId =>
  typeof value === "string" && Object.hasOwn(pros, value);
