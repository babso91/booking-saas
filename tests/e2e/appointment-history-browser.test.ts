import { describe, expect, it } from "vitest";

import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, professionalWithVisit } from "./support/studio";

// Point 100 in a real browser, on a phone: she changes an appointment, then
// reads in its card who changed it and what.

const SCREENSHOT = process.env.HISTORY_SCREENSHOT;

const parisDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(),
  );

describe("appointment history in a browser", () => {
  it("marks the visit done, then reads who changed it and what", async () => {
    const { browser, appointmentId } = await professionalWithVisit(
      "Nora",
      "Inès",
    );
    const { page, errors } = await signedInPage(browser, {
      width: 390,
      height: 844,
      phone: true,
    });
    await page.goto(`${APP}/app?date=${parisDate()}&rdv=${appointmentId}`);
    const card = page.getByRole("dialog");
    await card
      .getByRole("heading", { name: "Rendez-vous", exact: true })
      .waitFor();

    await (
      await hydrated(card.getByRole("button", { name: "Marquer terminé" }))
    ).click();
    await page
      .getByRole("alertdialog")
      .or(page.getByRole("dialog", { name: "Marquer comme terminé ?" }))
      .getByRole("button", { name: "Marquer terminé" })
      .click();
    await card.getByText("Terminé", { exact: true }).first().waitFor();

    const toggle = card.getByRole("button", {
      name: "Historique des modifications",
    });
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    const list = card.getByRole("region", { name: "Historique" });
    await list.getByText("Statut : Confirmé → Terminé").waitFor();
    const text = await list.innerText();
    expect(text).toContain("Toi");
    // Placed by a database script in this test: the system made it.
    expect(text).toMatch(
      /Higani[\s\S]*Rendez-vous créé : .+ · Rehaussement de cils/,
    );
    expect(text.indexOf("Statut : Confirmé → Terminé")).toBeLessThan(
      text.indexOf("Rendez-vous créé"),
    );

    expect(await noSideScroll(page)).toBe(true);
    if (SCREENSHOT) {
      await list.scrollIntoViewIfNeeded();
      await page.screenshot({ path: SCREENSHOT });
    }
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
