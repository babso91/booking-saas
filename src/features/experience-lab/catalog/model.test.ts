import { describe, expect, it } from "vitest";

import { universes } from "../universes";
import {
  addCategory,
  addService,
  bookableServices,
  eurosInput,
  moveCategory,
  moveService,
  moveServiceTo,
  parseEuros,
  quote,
  removeCategory,
  removeService,
  showcase,
  updateCategory,
  updateService,
  validate,
  type Catalog,
  type CatalogService,
} from "./model";
import { isProId, pros } from "./pros";

const svc = (
  id: string,
  categoryId: string | null,
  extra: Partial<CatalogService> = {},
): CatalogService => ({
  id,
  categoryId,
  name: `Service ${id}`,
  description: "",
  durationMinutes: 30,
  priceCents: 1000,
  active: true,
  options: [],
  ...extra,
});

const base = (): Catalog => ({
  categories: [
    { id: "a", name: "A", visible: true },
    { id: "b", name: "B", visible: true },
    { id: "h", name: "Cachée", visible: false },
    { id: "e", name: "Vide", visible: true },
  ],
  services: [
    svc("a1", "a"),
    svc("b1", "b"),
    svc("a2", "a"),
    svc("h1", "h"),
    svc("n1", null),
    svc("u1", "ghost"),
    svc("a3", "a", { active: false }),
    svc("a4", "a", { name: "  " }),
  ],
});

const ids = (services: CatalogService[]) => services.map((s) => s.id);

const withOption = (extra: Partial<CatalogService> = {}) =>
  svc("o", "a", {
    options: [
      {
        id: "opt",
        question: "Dépose ?",
        choices: [
          {
            id: "c0",
            label: "Non",
            priceDeltaCents: 0,
            durationDeltaMinutes: 0,
          },
          {
            id: "c1",
            label: "Oui",
            priceDeltaCents: 500,
            durationDeltaMinutes: 15,
          },
        ],
      },
    ],
    ...extra,
  });

describe("showcase", () => {
  const groups = showcase(base());

  it("leaves out hidden and empty categories", () => {
    const names = groups.map((g) => g.category?.id);
    expect(names).not.toContain("h");
    expect(names).not.toContain("e");
  });

  it("leaves out inactive and unnamed services", () => {
    const all = groups.flatMap((g) => ids(g.services));
    expect(all).not.toContain("a3");
    expect(all).not.toContain("a4");
  });

  it("keeps her order, loose services last without a category", () => {
    expect(groups.map((g) => g.category?.id ?? null)).toEqual(["a", "b", null]);
    expect(ids(groups[0]!.services)).toEqual(["a1", "a2"]);
    expect(ids(groups[2]!.services)).toEqual(["n1", "u1"]);
  });

  it("orders bookable services as shown", () => {
    expect(ids(bookableServices(base()))).toEqual([
      "a1",
      "a2",
      "b1",
      "n1",
      "u1",
    ]);
  });
});

describe("quote", () => {
  it("uses the first choice by default", () => {
    expect(quote(withOption())).toEqual({
      priceCents: 1000,
      durationMinutes: 30,
    });
  });
  it("adds the picked choice's price and duration", () => {
    expect(quote(withOption(), { opt: "c1" })).toEqual({
      priceCents: 1500,
      durationMinutes: 45,
    });
  });
});

describe("validate", () => {
  const issuesFor = (patch: Partial<CatalogService>) =>
    validate({ categories: [], services: [svc("x", null, patch)] });
  const option = (patch: object) => ({
    id: "o",
    question: "Q ?",
    choices: [
      { id: "1", label: "Non", priceDeltaCents: 0, durationDeltaMinutes: 0 },
      { id: "2", label: "Oui", priceDeltaCents: 0, durationDeltaMinutes: 0 },
    ],
    ...patch,
  });

  it("accepts a valid catalogue", () => {
    const catalog = base();
    catalog.services = catalog.services.filter((s) => s.id !== "a4");
    expect(validate(catalog)).toEqual([]);
  });
  it("rejects an empty name", () => {
    expect(issuesFor({ name: " " })).toHaveLength(1);
  });
  it("rejects a name that is too long", () => {
    expect(issuesFor({ name: "x".repeat(121) })).toHaveLength(1);
  });
  it("rejects durations out of 5–720", () => {
    expect(issuesFor({ durationMinutes: 4 })).toHaveLength(1);
    expect(issuesFor({ durationMinutes: 721 })).toHaveLength(1);
    expect(issuesFor({ durationMinutes: 5 })).toHaveLength(0);
    expect(issuesFor({ durationMinutes: 720 })).toHaveLength(0);
  });
  it("rejects a negative price", () => {
    expect(issuesFor({ priceCents: -1 })).toHaveLength(1);
  });
  it("rejects an option without question", () => {
    expect(issuesFor({ options: [option({ question: " " })] })).toHaveLength(1);
  });
  it("rejects an option with fewer than two choices", () => {
    const one = option({}).choices.slice(0, 1);
    expect(issuesFor({ options: [option({ choices: one })] })).toHaveLength(1);
  });
  it("rejects a choice without label", () => {
    const choices = option({}).choices.map((c, i) =>
      i ? { ...c, label: "" } : c,
    );
    expect(issuesFor({ options: [option({ choices })] })).toHaveLength(1);
  });
  it("rejects a negative delta", () => {
    const choices = option({}).choices.map((c, i) =>
      i ? { ...c, priceDeltaCents: -5 } : c,
    );
    expect(issuesFor({ options: [option({ choices })] })).toHaveLength(1);
    const durations = option({}).choices.map((c, i) =>
      i ? { ...c, durationDeltaMinutes: -5 } : c,
    );
    expect(
      issuesFor({ options: [option({ choices: durations })] }),
    ).toHaveLength(1);
  });
  it("rejects a total with options over 720", () => {
    const choices = option({}).choices.map((c, i) =>
      i ? { ...c, durationDeltaMinutes: 60 } : c,
    );
    expect(
      issuesFor({ durationMinutes: 700, options: [option({ choices })] }),
    ).toHaveLength(1);
  });
  it("rejects bad category names", () => {
    const names = ["", "x".repeat(61)];
    for (const name of names) {
      expect(
        validate({
          categories: [{ id: "c", name, visible: true }],
          services: [],
        }),
      ).toHaveLength(1);
    }
  });
});

describe("category edits", () => {
  it("adds at the end", () => {
    const { catalog, id } = addCategory(base(), "Z");
    expect(catalog.categories.at(-1)).toEqual({ id, name: "Z", visible: true });
  });
  it("updates one category", () => {
    const next = updateCategory(base(), "b", { name: "Bis", visible: false });
    expect(next.categories[1]).toEqual({
      id: "b",
      name: "Bis",
      visible: false,
    });
    expect(next.categories[0]!.name).toBe("A");
  });
  it("moves, and is a no-op at the edges", () => {
    const order = (c: Catalog) => c.categories.map((x) => x.id).join("");
    expect(order(moveCategory(base(), "b", -1))).toBe(
      "abhe".replace("ab", "ba"),
    );
    expect(order(moveCategory(base(), "a", -1))).toBe("abhe");
    expect(order(moveCategory(base(), "e", 1))).toBe("abhe");
  });
  it("removes a category and keeps its services, now loose and last", () => {
    const next = removeCategory(base(), "a", true);
    expect(next.categories.map((c) => c.id)).toEqual(["b", "h", "e"]);
    expect(next.services.find((s) => s.id === "a1")!.categoryId).toBeNull();
    const last = showcase(next).at(-1)!;
    expect(last.category).toBeNull();
    expect(ids(last.services)).toEqual(expect.arrayContaining(["a1", "a2"]));
  });
  it("removes a category with its services", () => {
    const next = removeCategory(base(), "a", false);
    expect(next.services.some((s) => s.categoryId === "a")).toBe(false);
    expect(next.services).toHaveLength(4);
  });
});

describe("service edits", () => {
  it("appends a new service at the end of its category", () => {
    const { catalog, id } = addService(base(), "a");
    const inA = catalog.services.filter((s) => s.categoryId === "a");
    expect(inA.at(-1)!.id).toBe(id);
    expect(catalog.services).toHaveLength(base().services.length + 1);
  });
  it("copies right after the original with fresh ids", () => {
    const original = withOption({ id: "o" });
    const catalog = {
      ...base(),
      services: [svc("p", "a"), original, svc("q", "a")],
    };
    const { catalog: next, id } = addService(catalog, "a", original);
    expect(ids(next.services).slice(0, 3)).toEqual(["p", "o", id]);
    const copy = next.services[2]!;
    expect(copy.id).not.toBe("o");
    expect(copy.options[0]!.id).not.toBe("opt");
    expect(copy.options[0]!.choices.map((c) => c.id)).not.toContain("c0");
    expect(copy.options[0]!.choices.map((c) => c.id)).not.toContain("c1");
    expect(copy.options[0]!.choices[1]!.priceDeltaCents).toBe(500);
  });
  it("swaps only within its category, no-op at the edges", () => {
    const moved = moveService(base(), "a1", 1);
    expect(ids(moved.services).slice(0, 4)).toEqual(["a2", "b1", "a1", "h1"]);
    expect(ids(moveService(base(), "a1", -1).services)).toEqual(
      ids(base().services),
    );
    expect(ids(moveService(base(), "a4", 1).services)).toEqual(
      ids(base().services),
    );
    expect(ids(moveService(base(), "b1", 1).services)).toEqual(
      ids(base().services),
    );
  });
  it("moves into another category as its last service", () => {
    const next = moveServiceTo(base(), "a1", "b");
    const inB = next.services.filter((s) => s.categoryId === "b");
    expect(ids(inB)).toEqual(["b1", "a1"]);
    expect(moveServiceTo(base(), "a1", "a").services).toEqual(base().services);
  });
  it("removes a service", () => {
    expect(ids(removeService(base(), "a1").services)).not.toContain("a1");
  });
});

describe("money as typed", () => {
  it("parses euros", () => {
    expect(parseEuros("25")).toBe(2500);
    expect(parseEuros("25,5")).toBe(2550);
    expect(parseEuros("12,50 €")).toBe(1250);
    expect(parseEuros("abc")).toBeNull();
    expect(parseEuros("-3")).toBeNull();
    expect(parseEuros("1,234")).toBeNull();
  });
  it("formats cents back", () => {
    expect(eurosInput(2500)).toBe("25");
    expect(eurosInput(1250)).toBe("12,50");
  });
});

describe("fixtures", () => {
  const catalogs = [
    ...Object.values(pros).map((pro) => [pro.id, pro.catalog] as const),
    ...Object.values(universes).map((u) => [u.id, u.catalog] as const),
  ];

  it.each(catalogs)("%s validates with no issue", (_name, catalog) => {
    expect(validate(catalog)).toEqual([]);
  });

  it("épilation is a long catalogue", () => {
    const { categories, services } = pros.epilation.catalog;
    expect(categories.length).toBeGreaterThanOrEqual(15);
    expect(services.length).toBeGreaterThanOrEqual(35);
  });

  it("henné has two categories, a loose service and extreme durations", () => {
    const { categories, services } = pros.henne.catalog;
    expect(categories).toHaveLength(2);
    expect(services.some((s) => s.categoryId === null)).toBe(true);
    expect(
      Math.min(...services.map((s) => s.durationMinutes)),
    ).toBeLessThanOrEqual(15);
    expect(
      Math.max(...services.map((s) => s.durationMinutes)),
    ).toBeGreaterThanOrEqual(360);
  });

  it("cils' Volume russe costs 30 € with a dépose", () => {
    const service = pros.cils.catalog.services.find(
      (s) => s.name === "Volume russe",
    )!;
    expect(service.priceCents).toBe(2500);
    expect(
      quote(service, { "cils-depose": "cils-depose-oui" }).priceCents,
    ).toBe(3000);
  });

  it.each(Object.values(pros).map((p) => [p.id, p] as const))(
    "%s: the showcase has no empty group and no hidden category",
    (_id, pro) => {
      const hidden = new Set(
        pro.catalog.categories.filter((c) => !c.visible).map((c) => c.id),
      );
      for (const group of showcase(pro.catalog)) {
        expect(group.services.length).toBeGreaterThan(0);
        if (group.category) expect(hidden.has(group.category.id)).toBe(false);
      }
    },
  );

  it("recognises pro ids", () => {
    expect(isProId("cils")).toBe(true);
    expect(isProId("nope")).toBe(false);
    expect(isProId(undefined)).toBe(false);
  });

  describe("a field typed wrong (I2)", () => {
    const base = pros.cils.catalog;
    const service = base.services.find(
      (item) => item.active && item.options.length,
    )!;

    it.each([Number.NaN, -1200, 12.5, 10_000_000])(
      "price %s: blocks publishing, named, and the service is not shown",
      (priceCents) => {
        const catalog = updateService(base, service.id, { priceCents });
        const issues = validate(catalog).filter(
          (issue) => issue.serviceId === service.id,
        );
        expect(issues.map((issue) => issue.text).join(" ")).toMatch(
          /prix à corriger/,
        );
        expect(
          bookableServices(catalog).some((item) => item.id === service.id),
        ).toBe(false);
      },
    );

    it("a supplement typed wrong blocks publishing, naming the option and the answer", () => {
      const option = service.options[0]!;
      const catalog = updateService(base, service.id, {
        options: [
          {
            ...option,
            choices: option.choices.map((choice, index) =>
              index === 1 ? { ...choice, priceDeltaCents: Number.NaN } : choice,
            ),
          },
        ],
      });
      const text = validate(catalog)
        .filter((issue) => issue.serviceId === service.id)
        .map((issue) => issue.text)
        .join(" ");
      expect(text).toMatch(/supplément à corriger/);
      expect(text).toMatch(/réponse 2/);
      expect(
        bookableServices(catalog).some((item) => item.id === service.id),
      ).toBe(false);
    });

    it("any price she chooses within the money model is hers: 0, cents, 99 999,99 €", () => {
      for (const priceCents of [0, 1250, 9_999_999]) {
        const catalog = updateService(base, service.id, { priceCents });
        expect(validate(catalog)).toEqual([]);
      }
    });
  });
});
