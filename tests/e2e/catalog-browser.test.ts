import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { capture } from "./support/capture";
import {
  expectAccessible,
  hydrated,
  look,
  noSideScroll,
  signedInPage,
} from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Her catalogue in the real app, against PostgreSQL: a category of her own
// (no trade imposed), a service put in it, the category hidden online then
// deleted. Every write is applied at once and read back from the database
// and from the public API her mini-site reads. On a computer and on small
// phones, in several styles.

const VARIANTS = [
  {
    name: "computer, Classique",
    appearance: look("classique"),
    width: 1280,
    phone: false,
  },
  {
    name: "phone 390, Carnet",
    appearance: look("carnet"),
    width: 390,
    phone: true,
  },
  {
    name: "phone 320, Studio",
    appearance: look("studio", "dark"),
    width: 320,
    phone: true,
  },
];

async function publicCatalog(slug: string) {
  const response = await fetch(`${APP}/api/public/businesses/${slug}`);
  expect(response.ok).toBe(true);
  return (await response.json()) as {
    services: { name: string }[];
    catalog: {
      groups: {
        category: { name: string } | null;
        services: { name: string }[];
      }[];
    };
  };
}

const saveDialog = async (page: Page) => {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Enregistrer/ }).click();
  await dialog.waitFor({ state: "detached" });
};

describe.each(VARIANTS)(
  "her catalogue — $name",
  ({ name, appearance, width, phone }) => {
    it("a category of her own, a service in it, hidden online, then deleted", async () => {
      const { browser, businessId } = await professionalWithVisit(
        "Inès",
        "Lou",
      );
      const { rows } = await db.query<{ slug: string }>(
        "select slug from public.businesses where id = $1",
        [businessId],
      );
      const slug = rows[0]!.slug;
      const { page, errors } = await signedInPage(browser, {
        appearance,
        width,
        height: 800,
        phone,
      });
      const check = async (what: string) => {
        expect(await noSideScroll(page), what).toBe(true);
        await expectAccessible(page, what);
        await capture(page, `catalog ${name} ${what}`);
      };

      await page.goto(`${APP}/app/services`);
      await page
        .getByRole("heading", { name: "Prestations", level: 1 })
        .waitFor();
      const add = await hydrated(
        page.getByRole("button", { name: "Ajouter une catégorie" }),
      );
      await check("services");

      // A category she names herself.
      await add.click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("dialog").getByLabel("Nom").fill("Mains & henné");
      await check("new category");
      await saveDialog(page);
      await page
        .getByRole("heading", { name: "Mains & henné", level: 2 })
        .waitFor();
      const created = await db.query<{ id: string; visible: boolean }>(
        "select id, visible from public.service_categories where business_id = $1",
        [businessId],
      );
      expect(created.rows).toEqual([{ id: expect.any(String), visible: true }]);
      const categoryId = created.rows[0]!.id;

      // Her service, put in it.
      await page
        .getByRole("button", { name: "Modifier Rehaussement de cils" })
        .click();
      await page.getByRole("dialog").getByLabel("Catégorie").selectOption({
        label: "Mains & henné",
      });
      await check("edit service with category");
      await saveDialog(page);
      await page
        .getByRole("region", { name: "Mains & henné" })
        .getByRole("heading", { name: "Rehaussement de cils" })
        .waitFor();
      expect(
        (
          await db.query(
            "select category_id from public.services where business_id = $1",
            [businessId],
          )
        ).rows,
      ).toEqual([{ category_id: categoryId }]);
      expect(
        (await publicCatalog(slug)).catalog.groups.map((group) => [
          group.category?.name ?? null,
          group.services.map((service) => service.name),
        ]),
      ).toEqual([["Mains & henné", ["Rehaussement de cils"]]]);
      await check("services in a category");

      // Hidden online: no longer offered on her page, still hers here.
      await page
        .getByRole("button", { name: "Modifier la catégorie Mains & henné" })
        .click();
      await page.getByRole("dialog").getByRole("switch").click();
      await saveDialog(page);
      await page.getByText(/masquée : pas réservable en ligne/).waitFor();
      const hidden = await publicCatalog(slug);
      expect(hidden.catalog.groups).toEqual([]);
      expect(hidden.services).toEqual([]);

      // Deleted, after being said: the service stays, without a category.
      await page
        .getByRole("button", { name: "Modifier la catégorie Mains & henné" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "Supprimer cette catégorie" })
        .click();
      await dialog
        .getByText(/Sa prestation reste dans ta liste, sans catégorie/)
        .waitFor();
      await check("delete category");
      await dialog
        .getByRole("button", { name: "Supprimer la catégorie" })
        .click();
      await dialog.waitFor({ state: "detached" });
      await page
        .getByRole("list", { name: "Tes prestations, dans l’ordre" })
        .getByRole("heading", { name: "Rehaussement de cils" })
        .waitFor();
      expect(
        (
          await db.query(
            "select category_id from public.services where business_id = $1",
            [businessId],
          )
        ).rows,
      ).toEqual([{ category_id: null }]);
      expect(
        (await publicCatalog(slug)).catalog.groups.map(
          (group) => group.category,
        ),
      ).toEqual([null]);

      expect(errors).toEqual([]);
    });
  },
);
