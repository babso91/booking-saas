import { describe, expect, it } from "vitest";

import { capture } from "./support/capture";
import {
  expectAccessible,
  look,
  noSideScroll,
  signedInPage,
} from "./support/ecrin";
import { behindIngress } from "./support/ingress";
import { APP, Browser, db, professionalWithVisit } from "./support/studio";

// Her options editor in the real app, against PostgreSQL: a question and
// its answers written in Prestations, saved through her Server Action,
// then asked and priced by the server on her public booking page. An
// answer she removes is gone online too. On a phone and on a computer.

const VARIANTS = [
  { name: "phone 390", width: 390, phone: true, address: "203.0.113.41" },
  { name: "computer", width: 1280, phone: false, address: "203.0.113.42" },
];

type PublicOption = {
  question: string;
  required: boolean;
  choices: { label: string; priceDeltaCents: number }[];
};

async function publicOptions(slug: string): Promise<PublicOption[]> {
  const response = await fetch(`${APP}/api/public/businesses/${slug}`);
  expect(response.ok).toBe(true);
  const { data } = (await response.json()) as {
    data: {
      catalog: { groups: { services: { options: PublicOption[] }[] }[] };
    };
  };
  return data.catalog.groups.flatMap((group) =>
    group.services.flatMap((service) => service.options),
  );
}

describe.each(VARIANTS)(
  "her options editor — $name",
  ({ name, width, phone, address }) => {
    it("a question written in Prestations is asked and priced online; a removed answer is gone", async () => {
      const pro = await professionalWithVisit("Salomé", "Lou");
      const { rows } = await db.query<{ slug: string }>(
        "select slug from public.businesses where id = $1",
        [pro.businessId],
      );
      const slug = rows[0]!.slug;
      const { page, errors } = await signedInPage(pro.browser, {
        appearance: look("classique"),
        width,
        height: 860,
        phone,
      });
      const check = async (what: string) => {
        expect(await noSideScroll(page), what).toBe(true);
        await expectAccessible(page, what);
        await capture(page, `options editor ${name} ${what}`);
      };

      await page.goto(`${APP}/app/services`);
      await page
        .getByRole("button", { name: "Options de Rehaussement de cils" })
        .click();
      const sheet = page.getByRole("dialog");
      await sheet.getByText("Cette prestation n’a pas d’option.").waitFor();
      await check("empty");

      await sheet.getByRole("button", { name: "Ajouter une question" }).click();
      await sheet.getByLabel("Question posée à ta cliente").fill("Longueur");
      await sheet.getByLabel(/^Nom, réponse 1 /).fill("Naturelle");
      await sheet.getByRole("button", { name: "Ajouter une réponse" }).click();
      await sheet.getByLabel(/^Nom, réponse 2 /).fill("Volume");
      await sheet.getByLabel(/^Prix ajouté en euros, réponse 2 /).fill("15");
      await sheet.getByLabel(/^Minutes ajoutées, réponse 2 /).fill("30");
      await check("filled");
      await sheet
        .getByRole("button", { name: "Enregistrer les options" })
        .click();
      await sheet.waitFor({ state: "detached" });
      await page.getByText(/· 1 option$/).waitFor();

      // What the server kept, as her clients' page reads it.
      expect(await publicOptions(slug)).toMatchObject([
        {
          question: "Longueur",
          required: true,
          choices: [
            { label: "Naturelle", priceDeltaCents: 0 },
            { label: "Volume", priceDeltaCents: 1500 },
          ],
        },
      ]);

      // A client's browser: the question is asked, the server's quote shown.
      const client = await signedInPage(new Browser(), {
        appearance: null,
        width,
        height: 860,
        phone,
      });
      await behindIngress(client.page.context(), address);
      await client.page.goto(`${APP}/b/${slug}`);
      await client.page
        .getByRole("button", { name: /Rehaussement de cils/ })
        .click();
      await client.page
        .getByRole("heading", { name: "Personnalisez votre prestation" })
        .waitFor();
      await client.page.getByRole("radio", { name: /Volume/ }).check();
      await client.page.getByText(/^1 h 45 · 75,00\s€$/).waitFor();
      await capture(client.page, `options editor ${name} asked online`);

      // She removes the answer: named to the server, gone online.
      await page
        .getByRole("button", { name: "Options de Rehaussement de cils" })
        .click();
      await sheet.getByLabel(/^Nom, réponse 2 /).waitFor();
      await sheet
        .getByRole("button", { name: /^Retirer la réponse 2 / })
        .click();
      await sheet
        .getByRole("button", { name: "Enregistrer les options" })
        .click();
      await sheet.waitFor({ state: "detached" });
      expect(
        (await publicOptions(slug)).map((option) =>
          option.choices.map((choice) => choice.label),
        ),
      ).toEqual([["Naturelle"]]);

      expect(errors).toEqual([]);
      expect(client.errors).toEqual([]);
    });
  },
);
