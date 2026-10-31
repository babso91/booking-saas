import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import {
  applied,
  ECRIN,
  expectAccessible,
  hydrated,
  look,
  noSideScroll,
  signedInPage,
} from "./support/ecrin";
import { APP, professionalWithVisit } from "./support/studio";

// The shared screens in Écrin, with real data: really read, really usable,
// on a computer and a phone, light and dark. Nothing here saves anything.

const closeDialog = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
};

const VARIANTS = [
  { name: "computer, light", appearance: ECRIN, width: 1280, phone: false },
  {
    name: "computer, dark",
    appearance: look("ecrin", "dark"),
    width: 1280,
    phone: false,
  },
  { name: "phone, light", appearance: ECRIN, width: 390, phone: true },
  {
    name: "phone, dark",
    appearance: look("ecrin", "dark"),
    width: 390,
    phone: true,
  },
];

describe.each(VARIANTS)(
  "shared screens in Écrin — $name",
  ({ appearance, width, phone }) => {
    it("Clientes, Prestations, Fidélité, Horaires, Calendar, Apparence", async () => {
      const { browser } = await professionalWithVisit("Maëlys", "Camille");
      const { page, errors } = await signedInPage(browser, {
        appearance,
        width,
        height: 800,
        phone,
      });

      const arrive = async (path: string, heading: string) => {
        await page.goto(`${APP}${path}`);
        await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
        await page.waitForLoadState("networkidle");
        expect(await applied(page), path).toMatchObject({
          style: "ecrin",
          frame: 1,
        });
        expect(await page.getByText("Petit contretemps").count(), path).toBe(0);
        expect(await noSideScroll(page), path).toBe(true);
      };

      // Clientes: her real client, the add panel, the profile.
      await arrive("/app/clients", "Clientes");
      const client = await hydrated(
        page
          .getByRole("list", { name: "Liste des clientes" })
          .getByRole("link", { name: /Camille Visite/ }),
      );
      await expectAccessible(page, "clients");
      await page.getByRole("button", { name: /Ajouter une cliente/ }).click();
      await page.getByRole("dialog").waitFor();
      await expectAccessible(page, "add client");
      await closeDialog(page);
      await client.click();
      await page.waitForURL(/\/app\/clients\/[0-9a-f-]{36}/);
      await page.getByRole("heading", { name: /Camille Visite/ }).waitFor();
      await page.waitForLoadState("networkidle");
      expect(await noSideScroll(page)).toBe(true);
      await expectAccessible(page, "client profile");

      // Prestations: her real service, its panel, the add panel.
      await arrive("/app/services", "Prestations");
      const edit = await hydrated(
        page.getByRole("button", { name: "Modifier Rehaussement de cils" }),
      );
      await expectAccessible(page, "services");
      await edit.click();
      await page.getByRole("dialog").waitFor();
      await expectAccessible(page, "edit service");
      await closeDialog(page);

      // Fidélité: the program is read, the reward panel opens.
      await arrive("/app/loyalty", "Fidélité");
      const reward = await hydrated(
        page.getByRole("button", { name: /Nouvelle récompense/ }),
      );
      await expectAccessible(page, "loyalty");
      await reward.click();
      await page.getByRole("dialog").waitFor();
      await expectAccessible(page, "new reward");
      await closeDialog(page);

      // Horaires: the week is read, a day answers, nothing is saved.
      await arrive("/app/settings/hours", "Horaires");
      await page
        .getByRole("button", { name: /Enregistrer les horaires/ })
        .waitFor();
      await expectAccessible(page, "hours");
      const monday = await hydrated(page.getByLabel("Lundi ouvert"));
      const open = await monday.isChecked();
      await monday.click();
      expect(await monday.isChecked()).toBe(!open);

      await arrive("/app/settings/calendar", "Google Calendar");
      await expectAccessible(page, "calendar");

      await arrive("/app/settings/appearance", "Apparence");
      await expectAccessible(page, "appearance");

      expect(errors).toEqual([]);
      await page.context().close();
    }, 180_000);
  },
);
