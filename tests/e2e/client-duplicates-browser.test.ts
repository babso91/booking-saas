import { describe, expect, it } from "vitest";

import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Point 147 in a real browser, on a phone: from her directory to the two
// records that look alike, then « not the same person », then undone.

const SCREENSHOT = process.env.DUPLICATES_SCREENSHOT;

const dismissals = async (businessId: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        "select count(*) as n from public.client_duplicate_dismissals where business_id = $1",
        [businessId],
      )
    ).rows[0]!.n,
  );

describe("records that look alike in a browser", () => {
  it("from the directory: compared, said different, then undone", async () => {
    const { browser, businessId } = await professionalWithVisit("Nora", "Inès");
    // The same person booked again with another address and her phone.
    await db.query(
      `update public.clients set phone = '06 12 34 56 78' where business_id = $1`,
      [businessId],
    );
    await db.query(
      `insert into public.clients (business_id, first_name, last_name, email, phone)
       values ($1, 'Inès', 'Visite', 'ines.nouvelle@client.test.local', '+33 6 12 34 56 78')`,
      [businessId],
    );
    const { page, errors } = await signedInPage(browser, {
      width: 390,
      height: 844,
      phone: true,
    });
    await page.goto(`${APP}/app/clients`);
    await (
      await hydrated(
        page.getByRole("link", { name: "1 doublon possible à vérifier" }),
      )
    ).click();
    await page.waitForURL(/\/app\/clients\/doublons$/);

    const card = page
      .getByRole("list", { name: "Fiches qui se ressemblent" })
      .getByRole("listitem");
    await card.getByText("Même téléphone · Même nom").waitFor();
    expect(
      await card.getByRole("link", { name: /Voir la fiche/ }).count(),
    ).toBe(2);
    expect(await noSideScroll(page)).toBe(true);
    if (SCREENSHOT) await page.screenshot({ path: SCREENSHOT, fullPage: true });

    await (
      await hydrated(
        card.getByRole("button", { name: "Ce n’est pas la même personne" }),
      )
    ).click();
    await page.getByText(/ne te seront plus proposées/).waitFor();
    expect(await dismissals(businessId)).toBe(1);

    await page.getByRole("button", { name: "Annuler" }).click();
    await card.getByText("Même téléphone · Même nom").waitFor();
    expect(await dismissals(businessId)).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
