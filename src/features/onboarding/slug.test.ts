import { describe, expect, it } from "vitest";

import {
  getSlugIssue,
  normalizeSlugInput,
  RESERVED_SLUGS,
  slugify,
  suggestSlugs,
} from "./slug";

describe("slugify mirrors private.normalize_slug", () => {
  it.each([
    // Examples documented in docs/AUTH_ONBOARDING_CONTRACT.md and the migration.
    ["  Écrin de Camille ", "ecrin-de-camille"],
    ["Straße_Ærø", "strasse-aero"],
    ["  Studio Mila Lashes ! ", "studio-mila-lashes"],
    ["Écrin d'Éva", "ecrin-d-eva"],
    ["L’Instant Beauté", "l-instant-beaute"],
    ["!!!", ""],
  ])("%j → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("keeps at most 63 characters without a trailing hyphen", () => {
    const slug = slugify("institut ".repeat(12));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("normalizeSlugInput", () => {
  it("normalises while typing but keeps a trailing hyphen", () => {
    expect(normalizeSlugInput("Mila Beauté")).toBe("mila-beaute");
    expect(normalizeSlugInput("studio ")).toBe("studio-");
    expect(normalizeSlugInput("--mila!!cils")).toBe("mila-cils");
  });
});

describe("getSlugIssue", () => {
  it.each([
    ["", "empty"],
    ["!!", "empty"],
    ["ab", "too_short"],
    ["é!", "too_short"],
    ["login", "reserved"],
    ["Dashboard", "reserved"],
  ])("flags %j as %s", (input, issue) => {
    expect(getSlugIssue(input)).toBe(issue);
  });

  it("accepts anything the server would normalise to a valid slug", () => {
    expect(getSlugIssue("studio-mila")).toBeNull();
    expect(getSlugIssue("Mila Cils!")).toBeNull();
  });

  it("uses the backend's reserved words", () => {
    expect([...RESERVED_SLUGS].sort()).toEqual(
      [
        "account",
        "admin",
        "api",
        "app",
        "auth",
        "b",
        "dashboard",
        "help",
        "login",
        "logout",
        "onboarding",
        "register",
        "settings",
        "signin",
        "signup",
        "support",
        "www",
      ].sort(),
    );
  });
});

describe("suggestSlugs", () => {
  it("proposes normalised candidates different from the input", () => {
    const suggestions = suggestSlugs("studio-mila", {
      location: "Lyon 6e, France",
    });
    expect(suggestions[0]).toBe("studio-mila-lyon-6e");
    expect(suggestions).not.toContain("studio-mila");
    for (const suggestion of suggestions)
      expect(getSlugIssue(suggestion)).toBeNull();
  });

  it("does not repeat a first name already in the slug", () => {
    expect(suggestSlugs("mila-cils", { firstName: "Mila" })).not.toContain(
      "mila-cils-mila",
    );
  });
});
