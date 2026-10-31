import { chromium, type Browser as Chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  APP,
  professionalWithVisit,
  STUDIO,
  type Browser,
} from "./support/studio";

// Studio 2 in a real browser against the real backend: what the HTML of the
// first answer cannot show, because the agenda is read after hydration.

const parisDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(),
  );

let chrome: Chromium;
beforeAll(async () => {
  chrome = await chromium.launch();
});
afterAll(() => chrome.close());

/** A page signed in as this professional, in the Studio style. */
async function studioPage(browser: Browser, width = 1280, height = 800) {
  browser.cookies.set("dash_appearance", STUDIO);
  const context = await chrome.newContext({ viewport: { width, height } });
  await context.addCookies(
    [...browser.cookies].map(([name, value]) => ({ name, value, url: APP })),
  );
  return context.newPage();
}

describe("Studio 2 in a browser", () => {
  it("once the agenda is read, a link to another business's visit shows and receives nothing of it", async () => {
    const mine = await professionalWithVisit("Alma", "Rose");
    const theirs = await professionalWithVisit("Jade", "Zélie");
    const page = await studioPage(mine.browser);

    // Every answer passes through here, read in full: none can be missed.
    const answers: { what: string; body: string }[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const response = await route.fetch({ maxRedirects: 0 });
      answers.push({
        what: `${request.method()} ${request.url()} ${response.status()}`,
        body: await response.text(),
      });
      await route.fulfill({ response });
    });

    await page.goto(
      `${APP}/app?date=${parisDate()}&rdv=${theirs.appointmentId}`,
    );

    // The agenda is really there: her own visit, read after hydration.
    await page
      .getByRole("button", { name: /Rose Visite/ })
      .first()
      .waitFor();
    await page.waitForLoadState("networkidle");

    // The link opened nothing, and nothing of the other business is on screen.
    expect(await page.getByRole("dialog").count()).toBe(0);
    const screenText = await page.locator("body").innerText();
    const html = await page.content();
    for (const forbidden of ["Zélie", theirs.businessId, theirs.clientEmail]) {
      expect(screenText).not.toContain(forbidden);
      expect(html).not.toContain(forbidden);
    }

    // The capture really saw the read: her own data went through it…
    const seen = answers.map(
      ({ what, body }) => `${what} (${body.length} characters)`,
    );
    expect(
      answers.some(
        ({ what, body }) => what.startsWith("POST") && body.includes("Rose"),
      ),
      seen.join("\n"),
    ).toBe(true);
    // …and no answer carried theirs.
    for (const { what, body } of answers) {
      for (const forbidden of [
        "Zélie",
        theirs.businessId,
        theirs.clientEmail,
      ]) {
        expect(body.includes(forbidden), `${forbidden} in ${what}`).toBe(false);
      }
    }

    // Control: the same link to her own visit does open its card.
    await page.goto(`${APP}/app?date=${parisDate()}&rdv=${mine.appointmentId}`);
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("dialog").innerText()).toContain("Rose");

    await page.context().close();
  });

  it.each([320, 375, 390])(
    "at %i px the « ⋯ » menu opens entirely on screen, whatever the date",
    async (width) => {
      const { browser } = await professionalWithVisit("Lina", "Nour");
      const page = await studioPage(browser, width, 700);
      // Long and short weekday names, today and away from it.
      for (const date of [parisDate(), "2027-09-29", "2027-09-27"]) {
        await page.goto(`${APP}/app?date=${date}`);
        await page.getByRole("button", { name: "Options de l’agenda" }).click();
        const menu = page.locator("#agenda-options");
        await menu.waitFor();
        const box = (await menu.boundingBox())!;
        expect(box.x, date).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, date).toBeLessThanOrEqual(width);
        expect(box.y + box.height, date).toBeLessThanOrEqual(700);

        // Really usable: nothing over it, the option answers.
        await menu.getByLabel("Afficher les annulés").click();
        expect(
          await menu.getByLabel("Afficher les annulés").isChecked(),
          date,
        ).toBe(true);
      }
      await page.context().close();
    },
  );
});
