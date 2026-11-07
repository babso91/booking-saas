import { describe, expect, it } from "vitest";

import {
  categoriesAfterMove,
  orderAfterMove,
  sectionsOf,
  showcase,
  type CatalogCategory,
  type CatalogEntry,
} from "./catalog-view";

// No trade is named anywhere: henna, waxing and lashes are only the
// fixtures' words.

const category = (
  id: string,
  displayOrder: number,
  visible = true,
): CatalogCategory => ({
  id,
  name: `Catégorie ${id}`,
  visible,
  displayOrder,
  version: 1,
});

const entry = (
  id: string,
  displayOrder: number,
  categoryId: string | null,
  overrides: Partial<CatalogEntry> = {},
): CatalogEntry => ({
  id,
  name: `Prestation ${id}`,
  description: null,
  durationMinutes: 30,
  priceCents: 2000,
  active: true,
  displayOrder,
  categoryId,
  options: [],
  ...overrides,
});

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("sectionsOf", () => {
  it("her categories in her order, even empty or hidden, then those without one", () => {
    const sections = sectionsOf(
      [category("b", 2, false), category("a", 1), category("empty", 3)],
      [entry("s3", 3, "a"), entry("s1", 1, null), entry("s2", 2, "b")],
    );
    expect(sections.map((section) => section.category?.id ?? null)).toEqual([
      "a",
      "b",
      "empty",
      null,
    ]);
    expect(sections.map((section) => ids(section.services))).toEqual([
      ["s3"],
      ["s2"],
      [],
      ["s1"],
    ]);
  });

  it("without any category: one section, without a heading", () => {
    expect(sectionsOf([], [entry("s1", 1, null)])).toEqual([
      { category: null, services: [entry("s1", 1, null)] },
    ]);
    expect(sectionsOf([], [])).toEqual([{ category: null, services: [] }]);
  });

  it("a category this reading does not know (deleted meanwhile) is none", () => {
    const [section] = sectionsOf([], [entry("s1", 1, "gone")]);
    expect(section!.category).toBeNull();
    expect(ids(section!.services)).toEqual(["s1"]);
  });
});

describe("orderAfterMove", () => {
  const categories = [category("a", 1), category("b", 2)];
  // Global order: s1 (a), s2 (b), s3 (a), s4 (none).
  const services = [
    entry("s1", 1, "a"),
    entry("s2", 2, "b"),
    entry("s3", 3, "a"),
    entry("s4", 4, null),
  ];

  it("swaps with the neighbour of its section; the others keep their places", () => {
    expect(orderAfterMove(categories, services, "s3", -1)).toEqual([
      "s3",
      "s2",
      "s1",
      "s4",
    ]);
  });

  it("first or last of its section: nothing to send", () => {
    expect(orderAfterMove(categories, services, "s1", -1)).toBeNull();
    expect(orderAfterMove(categories, services, "s3", 1)).toBeNull();
    expect(orderAfterMove(categories, services, "s4", 1)).toBeNull();
    expect(orderAfterMove(categories, services, "missing", 1)).toBeNull();
  });
});

describe("categoriesAfterMove", () => {
  it("all of them, once, in the new order", () => {
    const categories = [category("a", 1), category("b", 2), category("c", 3)];
    expect(categoriesAfterMove(categories, "c", -1)).toEqual(["a", "c", "b"]);
    expect(categoriesAfterMove(categories, "a", -1)).toBeNull();
    expect(categoriesAfterMove(categories, "c", 1)).toBeNull();
  });
});

describe("showcase: what her clients see", () => {
  const option = {
    id: "o1",
    question: "Longueur",
    required: true,
    choices: [
      {
        id: "c1",
        label: "Courte",
        priceDeltaCents: 0,
        durationDeltaMinutes: 0,
      },
    ],
  };

  it("visible categories with an active service, in her order; then the rest, last", () => {
    expect(
      showcase(
        [
          category("hidden", 1, false),
          category("henne", 2),
          category("empty", 3),
          category("inactive-only", 4),
        ],
        [
          entry("loose", 1, null),
          entry("in-hidden", 2, "hidden"),
          entry("motif", 3, "henne", { options: [option] }),
          entry("off", 4, "inactive-only", { active: false }),
          entry("loose-off", 5, null, { active: false }),
        ],
        "EUR",
      ),
    ).toEqual({
      currency: "EUR",
      groups: [
        {
          category: { id: "henne", name: "Catégorie henne" },
          services: [
            {
              id: "motif",
              name: "Prestation motif",
              description: null,
              durationMinutes: 30,
              priceCents: 2000,
              options: [option],
            },
          ],
        },
        {
          category: null,
          services: [
            {
              id: "loose",
              name: "Prestation loose",
              description: null,
              durationMinutes: 30,
              priceCents: 2000,
              options: [],
            },
          ],
        },
      ],
    });
  });

  it("an empty catalogue shows no group at all", () => {
    expect(showcase([category("a", 1)], [], "EUR")).toEqual({
      currency: "EUR",
      groups: [],
    });
  });
});
