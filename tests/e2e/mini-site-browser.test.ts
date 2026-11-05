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
  { name: "phone 390", width: 390, phone: true },
  { name: "computer", width: 1280, phone: false },
];

async function saveDraft(
  businessId: string,
  actor: string,
  revision: number,
  name: string,
) {
  const config = sampleSite("mila");
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

describe.each(VARIANTS)("her mini-site — $name", ({ name, width, phone }) => {
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
    );
    await db.query("select * from public.publish_site($1, $2, $3)", [
      pro.businessId,
      actor,
      revision,
    ]);
    // A newer draft, never published: her clients never see it.
    await saveDraft(pro.businessId, actor, revision, "Brouillon secret");

    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width,
      height: 860,
      phone,
    });
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
    await sheet.getByRole("button", { name: /Rehaussement de cils/ }).waitFor();
    await capture(page, `mini-site ${name} booking`);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    expect(errors).toEqual([]);
  });
});
