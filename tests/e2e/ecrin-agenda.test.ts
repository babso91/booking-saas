import { describe, expect, it } from "vitest";

import { APP, Browser, professionalWithVisit } from "./support/studio";

// Écrin against the real backend (`next start` + local Supabase): home and
// agenda answer in the Écrin frame around real data, a link to a visit never
// reads another business's data, and the style is a reversible cookie.

const ECRIN = "atelier.light.standard.-.ecrin";
const STUDIO = "atelier.light.standard.-.studio";
const CLASSIQUE = "atelier.light.standard.-.classique";

/** The style really applied: the one value the server wrote on the page. */
const activeStyle = (html: string) =>
  [...html.matchAll(/data-style="([^"]*)"/g)].map((match) => match[1]);

const parisDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(),
  );

describe("Écrin against the real backend", () => {
  it("signed out: home and agenda lead to /login", async () => {
    for (const path of ["/app", "/app/today"]) {
      const response = await new Browser().get(path);
      expect(response.status, path).toBe(307);
      expect(new URL(response.location!, APP).pathname).toBe("/login");
    }
  });

  it("home: the visit going on, from the database, no amount of money", async () => {
    const { browser } = await professionalWithVisit("Maëlys", "Inès");
    browser.cookies.set("dash_appearance", ECRIN);
    const home = await browser.get("/app/today");
    expect(home.status).toBe(200);
    expect(home.html).toContain('data-style="ecrin"');
    expect(home.html).toContain("ecrin-ground");
    expect(home.html).toContain("Créneau en cours");
    expect(home.html).toContain("Inès");
    expect(home.html).not.toMatch(/\d\s?€/);
  });

  it("the style goes back and forth; nothing else changes", async () => {
    const { browser } = await professionalWithVisit("Alma", "Rose");
    browser.cookies.set("dash_appearance", ECRIN);
    const ecrin = await browser.get("/app");
    expect(ecrin.status).toBe(200);
    expect(ecrin.html).toContain('data-style="ecrin"');

    browser.cookies.set("dash_appearance", STUDIO);
    const studio = await browser.get("/app");
    expect(studio.html).toContain('data-style="studio"');
    expect(studio.html).not.toContain("ecrin-ground");

    browser.cookies.set("dash_appearance", CLASSIQUE);
    const classique = await browser.get("/app");
    expect(classique.html).toContain('data-style="classique"');
    expect(classique.html).not.toContain("ecrin-ground");
    expect((await browser.get("/app/today")).status).toBe(307);
  });

  it("a link to another business's visit reads nothing of it", async () => {
    const mine = await professionalWithVisit("Lina", "Nour");
    const theirs = await professionalWithVisit("Jade", "Zélie");
    mine.browser.cookies.set("dash_appearance", ECRIN);
    const response = await mine.browser.get(
      `/app?date=${parisDate()}&rdv=${theirs.appointmentId}`,
    );
    expect(response.status).toBe(200);
    expect(response.html).not.toContain("Zélie");
    expect(response.html).not.toContain(theirs.businessId);
  });

  it("hostile cookies and malformed links are never an error", async () => {
    const { browser } = await professionalWithVisit("Mila", "Eva");
    for (const cookie of [
      "atelier.light.standard.-.constructor",
      "atelier.light.standard.-.__proto__",
      "atelier.light.standard.-.ECRIN",
      "atelier.light.standard.-.ecrin%20",
      "atelier.light.standard.-.carnet",
      'atelier.light.standard.-."><script>alert(1)</script>',
    ]) {
      browser.cookies.set("dash_appearance", encodeURIComponent(cookie));
      const response = await browser.get("/app");
      expect(response.status, cookie).toBe(200);
      // No style outside the allowed list: the default, and its frame.
      expect(new Set(activeStyle(response.html)), cookie).toEqual(
        new Set(["classique"]),
      );
      expect(response.html, cookie).not.toContain("ecrin-ground");
      expect(response.html, cookie).not.toContain("<script>alert");
    }
    // Each field is read alone: a valid style stays, the rest falls back to
    // the defaults.
    browser.cookies.set("dash_appearance", "x.y.z.w.ecrin");
    const partial = await browser.get("/app");
    expect(partial.status).toBe(200);
    expect(new Set(activeStyle(partial.html))).toEqual(new Set(["ecrin"]));
    expect(partial.html).toContain("ecrin-ground");

    browser.cookies.set("dash_appearance", ECRIN);
    for (const query of ["rdv=not-a-uuid", "date=2026-02-30", "date=hier"]) {
      expect((await browser.get(`/app?${query}`)).status, query).toBe(200);
    }
  });
});
