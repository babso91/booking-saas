import type { Page } from "playwright";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { capture } from "./support/capture";
import { expectAccessible, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Her studio (/app/site) against the real stack (Auth, PostgreSQL,
// Storage), through her Server Actions (docs/SITE_PUBLISHING_CONTRACT.md):
// her draft saved by itself on its revision, a conflict never overwritten
// in silence, publishing, her public page, her history, a real photo sent
// and verified, her plan's rights. The demo photos of the universes are
// served locally here, and must never reach her database.

type Draft = {
  revision: number;
  config: Record<string, unknown> | null;
  restoredFrom: string | null;
  plan: string;
};

async function draftOf(businessId: string): Promise<Draft> {
  const { rows } = await db.query<Draft>(
    `select draft_revision as revision, draft_config as config,
            draft_restored_from as "restoredFrom", plan
       from public.sites where business_id = $1`,
    [businessId],
  );
  return (
    rows[0] ?? { revision: 0, config: null, restoredFrom: null, plan: "core" }
  );
}

async function slugOf(businessId: string) {
  const { rows } = await db.query<{ slug: string }>(
    "select slug from public.businesses where id = $1",
    [businessId],
  );
  return rows[0]!.slug;
}

const demoPhoto = sharp({
  create: { width: 64, height: 80, channels: 3, background: "#8a6f5a" },
})
  .jpeg()
  .toBuffer();

async function studioPage(
  pro: Awaited<ReturnType<typeof professionalWithVisit>>,
  width: number,
  phone: boolean,
  reduced: boolean,
) {
  const { page, errors } = await signedInPage(pro.browser, {
    appearance: null,
    width,
    height: 860,
    phone,
  });
  // The universes' demo photos, served here (never the network in a test).
  const body = await demoPhoto;
  await page.route("https://images.unsplash.com/**", (route) =>
    route.fulfill({ contentType: "image/jpeg", body }),
  );
  // Every console error counts: a hydration mismatch is one.
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  return { page, errors, consoleErrors };
}

async function saved(page: Page) {
  try {
    await page
      .getByRole("status")
      .filter({ hasText: "Brouillon enregistré" })
      .waitFor({ timeout: 15_000 });
  } catch (error) {
    // What she saw instead (an error, a conflict, another page).
    const seen = await page
      .evaluate(() =>
        (
          document.querySelector('[aria-label="Studio de création"]') ??
          document.body
        ).textContent?.slice(0, 600),
      )
      .catch(() => "(page unreadable)");
    throw new Error(`Draft not saved at ${page.url()}: ${seen}`, {
      cause: error,
    });
  }
}

async function chooseUniverse(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Univers", exact: true }).click();
  await page.getByRole("button", { name }).click();
}

const VARIANTS = [
  { name: "phone 390", width: 390, phone: true, reduced: false },
  { name: "phone 320, less motion", width: 320, phone: true, reduced: true },
  { name: "computer 1280", width: 1280, phone: false, reduced: false },
];

describe.each(VARIANTS)(
  "her studio — $name",
  ({ name, width, phone, reduced }) => {
    it("saves by itself, publishes, restores; nothing lost in a conflict", async () => {
      const pro = await professionalWithVisit("Mila", "Lou");
      const actor = pro.browser.member!.userId;
      const { page, errors, consoleErrors } = await studioPage(
        pro,
        width,
        phone,
        reduced,
      );
      await page.goto(`${APP}/app/site`);

      // Her first draft, saved by itself on revision 0 → 1.
      await saved(page);
      expect((await draftOf(pro.businessId)).revision).toBe(1);
      expect(await noSideScroll(page)).toBe(true);
      await expectAccessible(page, "studio");
      await capture(page, `studio ${name}`);

      // A change, saved a moment later on the next revision.
      await chooseUniverse(page, /Maison Alma/);
      await saved(page);
      let draft = await draftOf(pro.businessId);
      expect(draft.revision).toBe(2);
      expect(draft.config).toMatchObject({ universe: "alma" });
      // Her universe's demo photos dressed her preview: never saved.
      expect(JSON.stringify(draft.config)).not.toMatch(/demo:|unsplash/);

      // Published: version 1, and her public page shows it.
      await page.getByRole("button", { name: "Publier" }).click();
      await page.getByText("En ligne · version 1").waitFor();
      await page.getByRole("button", { name: "Publié ✓" }).waitFor();
      const { rows: versions } = await db.query<{ number: number }>(
        "select number from public.site_versions where business_id = $1",
        [pro.businessId],
      );
      expect(versions.map((version) => version.number)).toEqual([1]);
      const visitor = await page.context().newPage();
      await visitor.goto(`${APP}/b/${await slugOf(pro.businessId)}`);
      await visitor.getByText("Rehaussement de cils").first().waitFor();
      expect(
        await visitor.evaluate(() => document.documentElement.innerHTML),
      ).not.toMatch(/demo:|unsplash/);
      await visitor.close();

      // Another tab saves meanwhile: her next save is refused, nothing is
      // overwritten, and she chooses. (Publishing may have saved her draft
      // once more, with its readability corrections: read it again.)
      draft = await draftOf(pro.businessId);
      const before = draft.revision;
      const elsewhere = draft.config as { brand: Record<string, unknown> };
      await db.query(
        "select public.save_site_draft($1, $2, $3, 1, $4::jsonb)",
        [
          pro.businessId,
          actor,
          draft.revision,
          JSON.stringify({
            ...elsewhere,
            brand: { ...elsewhere.brand, intro: "Écrit dans un autre onglet." },
          }),
        ],
      );
      await chooseUniverse(page, /Nail Lab/);
      await page
        .getByRole("alert")
        .filter({ hasText: "modifié ailleurs" })
        .waitFor({ timeout: 15_000 });
      draft = await draftOf(pro.businessId);
      expect(draft.config).toMatchObject({
        universe: "alma",
        brand: { intro: "Écrit dans un autre onglet." },
      });
      await expectAccessible(page, "studio conflict");
      await page.getByRole("button", { name: "Garder ma version" }).click();
      await saved(page);
      draft = await draftOf(pro.businessId);
      // The other tab's revision, then hers on top of it, chosen.
      expect(draft.revision).toBe(before + 2);
      expect(draft.config).toMatchObject({ universe: "nail-lab" });

      // Version 1 taken back into her draft (never online directly).
      await page.getByRole("button", { name: "Historique" }).click();
      await page.getByText("Version 1 · en ligne").waitFor();
      await page
        .getByRole("button", { name: "Reprendre", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Remplacer mon brouillon" })
        .click();
      await page.getByText(/Version 1 reprise/).waitFor();
      await page.getByRole("button", { name: "Publié ✓" }).waitFor();
      draft = await draftOf(pro.businessId);
      expect(draft.config).toMatchObject({ universe: "alma" });
      expect(draft.restoredFrom).not.toBeNull();
      // Opened again: her draft as saved, nothing to save.
      await page.reload();
      await saved(page);
      expect((await draftOf(pro.businessId)).revision).toBe(draft.revision);

      expect(errors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  },
);

describe("her studio — her photos and her plan", () => {
  it("a real photo, sent, verified, saved by id and published", async () => {
    const pro = await professionalWithVisit("Alma", "Zoé");
    const { page, errors, consoleErrors } = await studioPage(
      pro,
      1280,
      false,
      false,
    );
    await page.goto(`${APP}/app/site`);
    await saved(page);

    await page.getByRole("button", { name: "Photos", exact: true }).click();
    // Her cover's place: empty in her first draft (no photo of hers yet).
    await page
      .locator('[aria-label="Studio de création"]')
      .getByRole("button", { name: "Couverture", exact: true })
      .click();
    const photo = await sharp({
      create: { width: 1600, height: 2000, channels: 3, background: "#c49a7a" },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
    await page.locator('input[type="file"]').setInputFiles({
      name: "pose.jpg",
      mimeType: "image/jpeg",
      buffer: photo,
    });
    // Hers, from the members' preview route, once verified.
    await page
      .locator('img[src*="/api/sites/photos/"]')
      .first()
      .waitFor({ timeout: 30_000 });
    await saved(page);
    const { rows: assets } = await db.query<{ id: string; status: string }>(
      "select id, status from public.site_assets where business_id = $1",
      [pro.businessId],
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]!.status).toBe("ready");
    const draft = await draftOf(pro.businessId);
    expect(JSON.stringify(draft.config)).toContain(
      `{"asset":"${assets[0]!.id}"}`,
    );
    expect(JSON.stringify(draft.config)).not.toMatch(/demo:|unsplash/);
    await expectAccessible(page, "studio photo");

    await page.getByRole("button", { name: "Publier" }).click();
    await page.getByText("En ligne · version 1").waitFor();
    const visitor = await page.context().newPage();
    await visitor.goto(`${APP}/b/${await slugOf(pro.businessId)}`);
    await visitor
      .locator(`img[src*="/site/photos/${assets[0]!.id}/"]`)
      .first()
      .waitFor();
    await visitor.close();

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  it("her plan is the server's; Signature settings are kept under Core", async () => {
    const pro = await professionalWithVisit("Nina", "Léa");
    const { page, errors } = await studioPage(pro, 390, true, true);
    await db.query("select public.set_site_plan($1, 'signature')", [
      pro.businessId,
    ]);
    await page.goto(`${APP}/app/site`);
    await saved(page);
    await page.getByText("Mode Créatif", { exact: true }).waitFor();
    // A Signature setting: her typography.
    await page.getByRole("button", { name: "Style", exact: true }).click();
    await page
      .getByRole("group", { name: "Typographie" })
      .getByRole("button", { pressed: false })
      .first()
      .click();
    await saved(page);
    const chosen = (
      (await draftOf(pro.businessId)).config as { tokens: { type: string } }
    ).tokens.type;

    // Back to Core (set by the service): the setting is kept, not shown.
    await db.query("select public.set_site_plan($1, 'core')", [pro.businessId]);
    await page.reload();
    await saved(page);
    await page.getByText("Mode Simple", { exact: true }).waitFor();
    expect(
      await page.getByRole("button", { name: "Style", exact: true }).count(),
    ).toBe(0);
    // An edit under Core never drops it.
    await page.getByRole("button", { name: "Textes", exact: true }).click();
    await page.getByLabel("Ville", { exact: true }).fill("Lyon 2e");
    await saved(page);
    const draft = (await draftOf(pro.businessId)).config as {
      tokens: { type: string };
      brand: { location: string };
    };
    expect(draft.brand.location).toBe("Lyon 2e");
    expect(draft.tokens.type).toBe(chosen);

    expect(errors).toEqual([]);
  });

  it("back to her space right after a change: the change is saved first", async () => {
    const pro = await professionalWithVisit("Iris", "Léa");
    // A computer: "Mon site" is in the sidebar, for client navigations.
    const { page, errors } = await studioPage(pro, 1280, false, true);
    await page.goto(`${APP}/app/site`);
    await saved(page);
    const location = async () =>
      (
        (await draftOf(pro.businessId)).config as {
          brand: { location: string };
        } | null
      )?.brand.location;

    // No wait for the autosave: she leaves at once, by the studio's link.
    await page.getByRole("button", { name: "Textes", exact: true }).click();
    await page.getByLabel("Ville", { exact: true }).fill("Nantes");
    await page.getByRole("link", { name: "Revenir à mon espace" }).click();
    await page.waitForURL(`${APP}/app`);
    expect(await location()).toBe("Nantes");

    // In again from her space, then Back in the browser: a client-side
    // navigation, no beforeunload. Sent all the same.
    await page.getByRole("link", { name: "Mon site" }).first().click();
    await page.waitForURL(`${APP}/app/site`);
    await saved(page);
    await page.getByRole("button", { name: "Textes", exact: true }).click();
    await page.getByLabel("Ville", { exact: true }).fill("Rennes");
    await page.goBack();
    await expect.poll(location, { timeout: 10_000 }).toBe("Rennes");

    expect(errors).toEqual([]);
  });
});
