import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectAccessible, noSideScroll } from "./support/ecrin";
import { APP } from "./support/studio";

// Higani's home in its own universe « Éclipse lunaire »: readable and
// accessible over the moving scene, on a phone and a desktop, and still
// when motion is reduced.

let chrome: Browser;
beforeAll(async () => {
  chrome = await chromium.launch();
});
afterAll(() => chrome.close());

describe("Higani's home (Éclipse lunaire)", () => {
  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [1440, 860],
  ] as const) {
    it(`at ${width}: its words, its one action, nothing sideways`, async () => {
      const page = await chrome.newPage({ viewport: { width, height } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${APP}/`);
      await page
        .getByRole("heading", {
          level: 1,
          name: "Ton lien. Ton univers. Tes rendez-vous.",
        })
        .waitFor();
      expect(await page.title()).toBe("Higani");
      const signIn = page.getByRole("link", { name: "Se connecter" });
      expect(await signIn.getAttribute("href")).toBe("/login");
      expect(
        await page
          .getByRole("link", { name: "Bêta privée, sur invitation" })
          .getAttribute("href"),
      ).toBe("/signup");
      // Its words stay inside the screen, above the fold.
      const box = await signIn.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      expect(await noSideScroll(page)).toBe(true);
      await expectAccessible(page, `home ${width}`);
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("is still when motion is reduced: no rain, petals at rest", async () => {
    const context = await chrome.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${APP}/`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === "running").length,
    );
    expect(running).toBe(0);
    await context.close();
  });

  it("signs in from its one action", async () => {
    const page = await chrome.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.goto(`${APP}/`);
    await page.getByRole("link", { name: "Se connecter" }).click();
    await page.waitForURL(/\/login$/);
    await page.close();
  });
});
