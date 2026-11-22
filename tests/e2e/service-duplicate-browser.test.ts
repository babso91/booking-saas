import { describe, expect, it } from "vitest";

import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Point 41 in a real browser, on a phone: she duplicates a service, changes
// only what differs, then offers it.

const SCREENSHOT = process.env.DUPLICATE_SCREENSHOT;

describe("duplicating a service in a browser", () => {
  it("copies, opens the copy, saves her changes and offers it", async () => {
    const { browser, businessId } = await professionalWithVisit("Nora", "Inès");
    const { page, errors } = await signedInPage(browser, {
      width: 390,
      height: 844,
      phone: true,
    });
    await page.goto(`${APP}/app/services`);
    await (
      await hydrated(
        page.getByRole("button", { name: "Dupliquer Rehaussement de cils" }),
      )
    ).click();

    const sheet = page.getByRole("dialog");
    const name = sheet.getByLabel(/^Nom/);
    await expect
      .poll(() => name.inputValue())
      .toBe("Rehaussement de cils (copie)");
    if (SCREENSHOT) {
      // After the sheet's opening animation.
      await page.waitForTimeout(800);
      await page.screenshot({ path: SCREENSHOT });
    }
    await name.fill("Rehaussement + teinture");
    await sheet.getByLabel(/^Prix/).fill("75");
    await sheet.getByRole("button", { name: /^Enregistrer/ }).click();
    await sheet.waitFor({ state: "detached" });

    const offer = page.getByRole("switch", {
      name: "Proposer Rehaussement + teinture",
    });
    await offer.click();
    await expect.poll(() => offer.isChecked()).toBe(true);

    const { rows } = await db.query(
      `select name, price_cents, duration_minutes, active
       from public.services where business_id = $1 order by created_at`,
      [businessId],
    );
    expect(rows).toEqual([
      {
        name: "Rehaussement de cils",
        price_cents: 6000,
        duration_minutes: 75,
        active: true,
      },
      {
        name: "Rehaussement + teinture",
        price_cents: 7500,
        duration_minutes: 75,
        active: true,
      },
    ]);
    expect(await noSideScroll(page)).toBe(true);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
