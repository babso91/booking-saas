import { describe, expect, it } from "vitest";

import { sampleSite } from "@/features/experience/fixtures/sample-sites";

import { capture } from "./support/capture";
import { expectAccessible, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, Browser, db, professionalWithVisit } from "./support/studio";

// Her published mini-site on the public page, against PostgreSQL: the
// version published (never the draft), her real catalogue, and the real
// booking opening from it. Written through the database functions of
// docs/SITE_PUBLISHING_CONTRACT.md (save_site_draft, publish_site), as her
// studio will.

const VARIANTS = [
  {
    name: "phone 390, Mila",
    width: 390,
    phone: true,
    reduced: false,
    universe: "mila" as const,
  },
  {
    name: "phone 320, Alma, less motion",
    width: 320,
    phone: true,
    reduced: true,
    universe: "alma" as const,
  },
  {
    name: "computer, Nail Lab",
    width: 1280,
    phone: false,
    reduced: false,
    universe: "nail-lab" as const,
  },
];

async function saveDraft(
  businessId: string,
  actor: string,
  revision: number,
  name: string,
  universe: "mila" | "alma" | "nail-lab",
) {
  const config = sampleSite(universe);
  const { rows } = await db.query<{ revision: number }>(
    "select public.save_site_draft($1, $2, $3, 1, $4::jsonb) as revision",
    [
      businessId,
      actor,
      revision,
      JSON.stringify({ ...config, brand: { ...config.brand, name } }),
    ],
  );
  return rows[0]!.revision;
}

describe.each(VARIANTS)(
  "her mini-site — $name",
  ({ name, width, phone, reduced, universe }) => {
    it("the published version, her catalogue, the real booking; never the draft", async () => {
      const pro = await professionalWithVisit("Mila", "Lou");
      const actor = pro.browser.member!.userId;
      const { rows } = await db.query<{ slug: string }>(
        "select slug from public.businesses where id = $1",
        [pro.businessId],
      );
      const slug = rows[0]!.slug;

      const revision = await saveDraft(
        pro.businessId,
        actor,
        0,
        "Studio Lumière",
        universe,
      );
      await db.query("select * from public.publish_site($1, $2, $3)", [
        pro.businessId,
        actor,
        revision,
      ]);
      // A newer draft, never published: her clients never see it.
      await saveDraft(
        pro.businessId,
        actor,
        revision,
        "Brouillon secret",
        universe,
      );

      const { page, errors } = await signedInPage(new Browser(), {
        appearance: null,
        width,
        height: 860,
        phone,
      });
      // Every console error counts: a hydration mismatch is one.
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${APP}/b/${slug}`);
      await page.getByText("Studio Lumière").first().waitFor();
      expect(await page.getByText("Brouillon secret").count()).toBe(0);
      // Her real service, from her catalogue (get_public_catalog).
      await page.getByText("Rehaussement de cils").first().waitFor();
      // No photo yet: drawn in her universe's colours, never a broken image.
      expect(await page.locator("img").count()).toBe(0);
      expect(await page.locator("[data-no-photo]").count()).toBeGreaterThan(0);
      expect(await noSideScroll(page)).toBe(true);
      await expectAccessible(page, "mini-site");
      await capture(page, `mini-site ${name}`);

      // The real booking, from her site.
      await page
        .locator("[data-header-action]")
        .getByRole("button", { name: "Réserver" })
        .click();
      const sheet = page.getByRole("dialog", {
        name: "Réserver chez Studio Lumière",
      });
      await sheet
        .getByRole("heading", { name: "Choisissez une prestation" })
        .waitFor();
      await sheet
        .getByRole("button", { name: /Rehaussement de cils/ })
        .waitFor();
      await capture(page, `mini-site ${name} booking`);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });

      expect(errors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  },
);

// Higani points 5 and 17: her practical infos, her usual hours read from
// her schedule, the index straight to them, and an empty gallery left out.
describe("her practical infos and the index", () => {
  it("phone 390: the index leads to her infos; her hours are her schedule's", async () => {
    const pro = await professionalWithVisit("Mila", "Lou");
    const actor = pro.browser.member!.userId;
    const { rows } = await db.query<{ slug: string }>(
      "select slug from public.businesses where id = $1",
      [pro.businessId],
    );
    const slug = rows[0]!.slug;
    await db.query("delete from public.business_hours where business_id = $1", [
      pro.businessId,
    ]);
    for (const [weekday, startsAt, endsAt] of [
      [1, "09:00", "12:30"],
      [1, "14:00", "19:00"],
      [6, "10:00", "17:00"],
    ] as const) {
      await db.query(
        `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
         values ($1, $2, $3, $4)`,
        [pro.businessId, weekday, startsAt, endsAt],
      );
    }
    const config = sampleSite("mila");
    expect(config.content.works).toEqual([]);
    const { rows: saved } = await db.query<{ revision: number }>(
      "select public.save_site_draft($1, $2, 0, 1, $3::jsonb) as revision",
      [
        pro.businessId,
        actor,
        JSON.stringify({
          ...config,
          brand: { ...config.brand, name: "Studio Lumière" },
          practical: {
            address: "12 rue Mercière, 69002 Lyon",
            area: "",
            access: "Code 4B12, 2e étage.",
            instructions: "Venir démaquillée.",
            payment: "CB, espèces",
            accessibility: "",
            phone: "04 78 00 00 00",
            email: "",
            showHours: true,
          },
        }),
      ],
    );
    await db.query("select * from public.publish_site($1, $2, $3)", [
      pro.businessId,
      actor,
      saved[0]!.revision,
    ]);

    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 390,
      height: 844,
      phone: true,
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${APP}/b/${slug}`);
    await page.getByText("Studio Lumière").first().waitFor();
    // No work published yet: no empty "Réalisations 00".
    expect(await page.getByText("Réalisations").count()).toBe(0);

    await page.getByRole("button", { name: "Sommaire" }).click();
    const index = page.getByRole("dialog", { name: "Sommaire" });
    await index.getByRole("button", { name: "Infos pratiques" }).waitFor();
    expect(
      await index.getByRole("button", { name: "Réalisations" }).count(),
    ).toBe(0);
    await expectAccessible(page, "mini-site index");
    await capture(page, "mini-site index 390");
    await index.getByRole("button", { name: "Infos pratiques" }).click();
    await index.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.id === "infos");

    const infos = page.locator("#infos");
    await infos.getByText("Horaires habituels").first().waitFor();
    // Her schedule's ranges, a lunch break included; closed days said.
    const monday = infos.getByRole("row", { name: /Lundi/ });
    expect(await monday.textContent()).toContain("9 h – 12 h 30, 14 h – 19 h");
    expect(
      await infos.getByRole("row", { name: /Mardi/ }).textContent(),
    ).toContain("Fermé");
    await infos.getByText("Code 4B12, 2e étage.").waitFor();
    expect(
      await infos
        .getByRole("link", { name: "04 78 00 00 00" })
        .getAttribute("href"),
    ).toBe("tel:0478000000");
    expect(
      await infos
        .getByRole("link", { name: /Itinéraire/ })
        .getAttribute("target"),
    ).toBe("_blank");
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "mini-site practical");
    await capture(page, "mini-site practical 390");

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
