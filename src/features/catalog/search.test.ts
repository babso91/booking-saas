import { describe, expect, it } from "vitest";

import type { PublicCatalogGroup, PublicCatalogService } from "./model";
import {
  SEARCH_FROM,
  resultLine,
  searchable,
  searchCatalog,
  wordsOf,
} from "./search";

const service = (
  id: string,
  name: string,
  extra: Partial<PublicCatalogService> = {},
): PublicCatalogService => ({
  id,
  name,
  description: null,
  durationMinutes: 60,
  priceCents: 5000,
  options: [],
  ...extra,
});

const groups: PublicCatalogGroup[] = [
  {
    category: { id: "c1", name: "Cils & regard" },
    services: [
      service("s1", "Volume russe", {
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
      }),
      service("s2", "Rehaussement", {
        description: "Courbés et teintés, rien d’ajouté.",
      }),
    ],
  },
  {
    category: { id: "c2", name: "Épilation" },
    services: [service("s3", "Restructuration sourcils")],
  },
  { category: null, services: [service("s4", "Soin semi-permanent")] },
];

const ids = (found: PublicCatalogGroup[]) =>
  found.flatMap((group) => group.services.map((item) => item.id));

describe("wordsOf", () => {
  it("lower case, without accents, split on anything but letters and digits", () => {
    expect(wordsOf("L’Épilation  semi-permanente 2h")).toEqual([
      "l",
      "epilation",
      "semi",
      "permanente",
      "2h",
    ]);
  });
});

describe("searchCatalog", () => {
  it("an empty query (or only spaces and signs) returns her catalogue unchanged", () => {
    expect(searchCatalog(groups, "")).toBe(groups);
    expect(searchCatalog(groups, "  ’ ")).toBe(groups);
  });

  it("finds by name, case and accents aside, by the start of a word", () => {
    expect(ids(searchCatalog(groups, "VOLUME"))).toEqual(["s1"]);
    expect(ids(searchCatalog(groups, "rehauss"))).toEqual(["s2"]);
    // "cils" starts no word of "sourcils": no false friend.
    expect(ids(searchCatalog(groups, "sourc"))).toEqual(["s3"]);
  });

  it("finds by category: every service of it", () => {
    expect(ids(searchCatalog(groups, "cils"))).toEqual(["s1", "s2"]);
    expect(ids(searchCatalog(groups, "epilation"))).toEqual(["s3"]);
  });

  it("finds by a word of the description or of a booking question", () => {
    expect(ids(searchCatalog(groups, "teintés"))).toEqual(["s2"]);
    expect(ids(searchCatalog(groups, "dépose"))).toEqual(["s1"]);
    expect(ids(searchCatalog(groups, "ancienne"))).toEqual(["s1"]);
  });

  it("every word typed must find something; her order and groups are kept", () => {
    expect(ids(searchCatalog(groups, "cils volume"))).toEqual(["s1"]);
    expect(ids(searchCatalog(groups, "cils sourcils"))).toEqual([]);
    expect(ids(searchCatalog(groups, "semi-perm"))).toEqual(["s4"]);
    const found = searchCatalog(groups, "r");
    expect(ids(found)).toEqual(["s1", "s2", "s3"]);
    expect(found.map((group) => group.category?.id)).toEqual(["c1", "c2"]);
  });

  it("drops the groups left empty", () => {
    const found = searchCatalog(groups, "restructuration");
    expect(found).toHaveLength(1);
    expect(found[0]!.category?.name).toBe("Épilation");
  });
});

describe("searchable", () => {
  it(`from ${SEARCH_FROM} services on`, () => {
    const many = (count: number): PublicCatalogGroup[] => [
      {
        category: null,
        services: Array.from({ length: count }, (_, index) =>
          service(`x${index}`, `Soin ${index}`),
        ),
      },
    ];
    expect(searchable(many(SEARCH_FROM - 1))).toBe(false);
    expect(searchable(many(SEARCH_FROM))).toBe(true);
  });
});

describe("resultLine", () => {
  it("says how many, or that nothing matches what she typed", () => {
    expect(resultLine(1, "x")).toBe("1 prestation");
    expect(resultLine(3, "x")).toBe("3 prestations");
    expect(resultLine(0, " brushing ")).toBe(
      "Aucune prestation ne correspond à « brushing »",
    );
  });
});
