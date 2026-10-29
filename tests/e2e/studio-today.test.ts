import { describe, expect, it } from "vitest";

import { APP, Browser, professionalWithVisit, STUDIO } from "./support/studio";

// Studio 1 against the real backend (`next start` + local Supabase): the
// "Aujourd’hui" page reads her day through the agenda's own read (RLS), in
// her style only, never another business's visits, and a hostile appearance
// cookie never breaks a page.

describe("Studio 1 against the real backend", () => {
  it("signed out: « Aujourd’hui » leads to /login", async () => {
    const response = await new Browser().get("/app/today");
    expect(response.status).toBe(307);
    expect(new URL(response.location!, APP).pathname).toBe("/login");
  });

  it("Studio: her slot going on now, from her agenda only", async () => {
    const mine = await professionalWithVisit("Maëlys", "Inès");
    const theirs = await professionalWithVisit("Alma", "Zélie");

    mine.browser.cookies.set("dash_appearance", STUDIO);
    const today = await mine.browser.get("/app/today");
    expect(today.status).toBe(200);
    expect(today.html).toContain("Créneau en cours");
    expect(today.html).toContain("Inès Visite");
    // Another business's visit is never read, not even into the payload.
    expect(today.html).not.toContain("Zélie");
    expect(today.html).not.toContain(theirs.appointmentId);
    // Her visit leads to the agenda with its details.
    expect(today.html).toContain(`rdv=${mine.appointmentId}`);
  });

  it("Classique: this address leads to the agenda", async () => {
    const { browser } = await professionalWithVisit("Jade", "Rose");
    browser.cookies.set(
      "dash_appearance",
      "atelier.light.standard.-.classique",
    );
    const response = await browser.get("/app/today");
    expect(response.status).toBe(307);
    expect(new URL(response.location!, APP).pathname).toBe("/app");
  });

  it("a hostile appearance cookie never breaks a page (no 500)", async () => {
    const { browser } = await professionalWithVisit("Lina", "Nour");
    for (const value of [
      "constructor.dark.none.-.studio",
      "__proto__.light.standard.-.studio",
      "toString.toString.toString.toString.toString",
      "lin.dark.none.zzzzzz.studio;}body{display:none",
      "%E0%A4%A",
    ]) {
      browser.cookies.set("dash_appearance", value);
      for (const path of ["/app", "/app/today", "/app/settings/appearance"]) {
        const response = await browser.get(path);
        expect([200, 307], `${value} ${path}`).toContain(response.status);
        expect(response.html).not.toContain("display:none");
      }
    }
  });
});
