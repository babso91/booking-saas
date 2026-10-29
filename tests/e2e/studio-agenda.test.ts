import { describe, expect, it } from "vitest";

import { APP, Browser, professionalWithVisit, STUDIO } from "./support/studio";

// Studio 2 against the real backend (`next start` + local Supabase): the
// agenda page in her style serves the Studio frame around the same agenda,
// a link to a visit (?rdv=) never reads another business's data, and
// switching style back and forth is a cookie, nothing more.

const parisDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(),
  );

describe("Studio 2 against the real backend", () => {
  it("signed out: the agenda leads to /login", async () => {
    const response = await new Browser().get("/app");
    expect(response.status).toBe(307);
    expect(new URL(response.location!, APP).pathname).toBe("/login");
  });

  it("Studio: the agenda answers in the Studio frame, reversible to Classique", async () => {
    const { browser } = await professionalWithVisit("Maëlys", "Inès");

    browser.cookies.set("dash_appearance", STUDIO);
    const studio = await browser.get("/app");
    expect(studio.status).toBe(200);
    expect(studio.html).toContain('data-style="studio"');
    // The Studio dock: « Aujourd’hui » first.
    expect(studio.html).toContain('href="/app/today"');

    browser.cookies.set(
      "dash_appearance",
      "atelier.light.standard.-.classique",
    );
    const classique = await browser.get("/app");
    expect(classique.status).toBe(200);
    expect(classique.html).toContain('data-style="classique"');
    expect(classique.html).not.toContain('href="/app/today"');
  });

  it("a link to another business's visit reads nothing of it", async () => {
    const mine = await professionalWithVisit("Alma", "Rose");
    const theirs = await professionalWithVisit("Jade", "Zélie");
    mine.browser.cookies.set("dash_appearance", STUDIO);

    const response = await mine.browser.get(
      `/app?date=${parisDate()}&rdv=${theirs.appointmentId}`,
    );
    expect(response.status).toBe(200);
    expect(response.html).not.toContain("Zélie");
    expect(response.html).not.toContain(theirs.businessId);
  });

  it("malformed links are ignored, never an error", async () => {
    const { browser } = await professionalWithVisit("Lina", "Nour");
    browser.cookies.set("dash_appearance", STUDIO);
    for (const query of [
      "rdv=not-a-uuid",
      "rdv=../../app/clients",
      "date=2026-02-30&rdv=00000000-0000-4000-8000-000000000000",
      "date=hier",
    ]) {
      const response = await browser.get(`/app?${query}`);
      expect(response.status, query).toBe(200);
    }
  });
});
