import { describe, expect, it } from "vitest";

import {
  getSlugIssue,
  normalizeSlugInput,
  slugify,
  suggestSlugs,
} from "./slug";

describe("slugify", () => {
  it("builds a clean slug from a business name", () => {
    expect(slugify("Studio Mila Lashes")).toBe("studio-mila-lashes");
    expect(slugify("  Atelier Lumière & Ongles ")).toBe(
      "atelier-lumiere-et-ongles",
    );
    expect(slugify("L’Instant Beauté")).toBe("linstant-beaute");
    expect(slugify("!!!")).toBe("");
  });

  it("truncates long names on a word boundary within 63 characters", () => {
    const slug = slugify("institut ".repeat(12));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
    expect(getSlugIssue(slug)).toBeNull();
  });
});

describe("normalizeSlugInput", () => {
  it("lowercases, strips accents and turns spaces into hyphens", () => {
    expect(normalizeSlugInput("Mila Beauté")).toBe("mila-beaute");
    expect(normalizeSlugInput("mila_cils")).toBe("mila-cils");
  });

  it("keeps invalid characters visible so the error can explain them", () => {
    expect(normalizeSlugInput("mila!")).toBe("mila!");
  });
});

describe("getSlugIssue", () => {
  it.each([
    ["", "empty"],
    ["ab", "too_short"],
    ["mila!", "invalid_chars"],
    ["-mila", "edge_hyphen"],
    ["mila-", "edge_hyphen"],
    ["mila--cils", "double_hyphen"],
    ["login", "reserved"],
    ["a".repeat(64), "too_long"],
  ])("flags %j as %s", (slug, issue) => {
    expect(getSlugIssue(slug)).toBe(issue);
  });

  it("accepts valid slugs", () => {
    expect(getSlugIssue("studio-mila")).toBeNull();
    expect(getSlugIssue("mila2")).toBeNull();
  });
});

describe("suggestSlugs", () => {
  it("returns up to three valid alternatives different from the input", () => {
    const suggestions = suggestSlugs("studio-mila", { location: "Lyon" });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestions).not.toContain("studio-mila");
    expect(suggestions[0]).toBe("studio-mila-lyon");
    for (const suggestion of suggestions)
      expect(getSlugIssue(suggestion)).toBeNull();
  });

  it("does not repeat a first name already in the slug", () => {
    expect(suggestSlugs("mila-cils", { firstName: "Mila" })).not.toContain(
      "mila-cils-mila",
    );
  });
});
