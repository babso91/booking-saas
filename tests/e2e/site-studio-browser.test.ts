import type { Locator, Page } from "playwright";
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
  it("a real photo, sent, labelled independently for each work and published", async () => {
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

    // Reusing an image in three gallery entries must keep their titles
    // separate, the third one included (Higani point 17).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "← Réglages", exact: true }).click();
    for (const title of ["Cil à cil", "Volume mixte", "Brow lift"]) {
      await page
        .getByRole("button", { name: "Ajouter une réalisation" })
        .click();
      await page
        .getByRole("button", { name: "Mes photos", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Utiliser la photo 1", exact: true })
        .click();
      await page.getByLabel("Titre sous la photo").fill(title);
      await page
        .getByRole("button", { name: "← Réglages", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Textes", exact: true }).click();
    expect(
      await page.getByLabel("Titre de la réalisation 2").inputValue(),
    ).toBe("Volume mixte");
    await page
      .getByLabel("Titre de la réalisation 1")
      .fill("Rehaussement de cils");
    await saved(page);
    expect(await noSideScroll(page)).toBe(true);
    expect((await draftOf(pro.businessId)).config).toMatchObject({
      content: {
        works: [
          { photo: { asset: assets[0]!.id }, title: "Rehaussement de cils" },
          { photo: { asset: assets[0]!.id }, title: "Volume mixte" },
          { photo: { asset: assets[0]!.id }, title: "Brow lift" },
        ],
      },
    });
    await page.reload();
    await saved(page);
    await page.getByRole("button", { name: "Textes", exact: true }).click();
    expect(
      await page.getByLabel("Titre de la réalisation 1").inputValue(),
    ).toBe("Rehaussement de cils");
    expect(
      await page.getByLabel("Titre de la réalisation 3").inputValue(),
    ).toBe("Brow lift");

    await page.getByRole("button", { name: "Publier" }).click();
    await page.getByText("En ligne · version 1").waitFor();
    const visitor = await page.context().newPage();
    await visitor.goto(`${APP}/b/${await slugOf(pro.businessId)}`);
    await visitor
      .locator(`img[src*="/site/photos/${assets[0]!.id}/"]`)
      .first()
      .waitFor();
    await visitor
      .getByRole("button", { name: /Volume mixte/ })
      .getByText("Volume mixte", { exact: true })
      .waitFor();
    await visitor
      .getByRole("button", { name: /Brow lift/ })
      .getByText("Brow lift", { exact: true })
      .waitFor();
    const published = await db.query<{ config: unknown }>(
      `select v.config from public.site_versions v
       join public.sites s on s.published_version_id = v.id
       where s.business_id = $1`,
      [pro.businessId],
    );
    expect(published.rows[0]!.config).toMatchObject({
      content: { works: [{}, {}, { title: "Brow lift" }] },
    });
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
  it("publishes independent titles, gallery, optional logo and Signature section order", async () => {
    const pro = await professionalWithVisit("Rosa", "Léa");
    await db.query("select public.set_site_plan($1, 'signature')", [
      pro.businessId,
    ]);
    const { page, errors } = await studioPage(pro, 390, true, true);
    const studio = page.getByRole("dialog", { name: "Studio de création" });
    const tab = (name: string) =>
      studio.getByRole("button", { name, exact: true }).click();
    await page.goto(APP + "/app/site");
    await saved(page);
    await tab("Sections");
    await tab("Descendre Ouverture");
    const intro = studio
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "Manifeste" }) });
    await studio.locator("summary", { hasText: "Manifeste" }).click();
    await intro
      .getByLabel("Titre sur la page", { exact: true })
      .fill("Les mots de Rosa");
    await intro.getByLabel("Masquer le titre").check();
    await intro.getByLabel("Nom dans le sommaire").fill("Mon histoire");
    await tab("Textes");
    await studio
      .getByRole("textbox", { name: /^Présentation/ })
      .fill("Je réalise chaque pose dans mon atelier de Lyon.");
    await studio
      .getByLabel("Texte du bouton de réservation")
      .fill("Prendre rendez-vous");
    await tab("Photos");
    await studio
      .getByLabel("Présentation des réalisations")
      .selectOption("filmstrip");
    await studio.getByLabel("Animation de la galerie").selectOption("snap");
    await tab("Logo");
    const logo = await sharp({
      create: { width: 300, height: 54, channels: 4, background: "#73531480" },
    })
      .png()
      .toBuffer();
    await studio
      .getByLabel("Choisir un logo")
      .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: logo });
    await studio.getByAltText("Aperçu du logo").waitFor();
    await tab("← Réglages");
    await tab("Ajouter une réalisation");
    await tab("Mes photos");
    await tab("Utiliser la photo 1");
    await studio.getByLabel("Titre sous la photo").fill("Volume mixte");
    await tab("← Réglages");
    await saved(page);
    await tab("Publier");
    await studio.getByText("En ligne · version 1").waitFor();
    const visitor = await page
      .context()
      .browser()!
      .newPage({
        viewport: { width: 390, height: 844 },
        reducedMotion: "reduce",
      });
    try {
      await visitor.goto(APP + "/b/" + (await slugOf(pro.businessId)));
      const kinds = () =>
        visitor
          .locator("main > [data-site-section]")
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-site-section")),
          );
      expect((await kinds())[0]).toBe("intro");
      expect(await visitor.locator("#presentation").innerText()).toContain(
        "chaque pose",
      );
      expect(await visitor.locator("#presentation").innerText()).not.toContain(
        "Les mots de Rosa",
      );
      expect(
        await visitor
          .locator("[data-blend-logotype] img")
          .evaluate((el: HTMLImageElement) =>
            el.decode().then(() => el.naturalWidth),
          ),
      ).toBeGreaterThan(0);
      await visitor
        .locator("[data-header-action]")
        .getByRole("button", { name: "Prendre rendez-vous" })
        .waitFor();
      expect(await visitor.locator("#realisations .snap-x").count()).toBe(1);
      expect(
        await visitor.locator('#realisations [data-reveal="snap"]').count(),
      ).toBeGreaterThan(0);
      await visitor
        .locator("#realisations")
        .getByText("Volume mixte")
        .waitFor();
      await visitor.getByRole("button", { name: "Sommaire" }).click();
      await visitor.getByRole("button", { name: "Mon histoire" }).click();
      await visitor.waitForFunction(
        () => document.activeElement?.id === "presentation",
      );
      expect(await noSideScroll(visitor)).toBe(true);
      await db.query("select public.set_site_plan($1, 'core')", [
        pro.businessId,
      ]);
      await visitor.reload();
      expect((await kinds())[0]).toBe("opening");
      expect(await visitor.locator("#realisations .snap-x").count()).toBe(1);
      await page.reload();
      await saved(page);
      await tab("Sections");
      expect(
        await studio
          .getByRole("button", { name: "Descendre Ouverture" })
          .count(),
      ).toBe(0);
      await tab("Photos");
      await tab("Logo");
      await tab("Retirer le logo");
      await saved(page);
      await visitor.reload();
      expect(await visitor.locator("[data-blend-logotype] img").count()).toBe(
        1,
      );
      await tab("Publier");
      await studio.getByText("En ligne · version 2").waitFor();
      await visitor.reload();
      expect(await visitor.locator("[data-blend-logotype] img").count()).toBe(
        0,
      );
      expect(
        (await visitor.locator("[data-blend-logotype]").innerText()).trim()
          .length,
      ).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally {
      await visitor.close();
    }
  });
});

// Higani points 120 to 124: find what to edit from her preview, keep her
// content through a change of universe, check her page as her clients see it.
describe("Studio: find, keep, check (points 120 to 124)", () => {
  const attr = (locator: Locator, name: string) => () =>
    locator.getAttribute(name);

  async function withHours(name: string, client: string) {
    const pro = await professionalWithVisit(name, client);
    await db.query(
      `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
       select $1, weekday, '08:00', '20:00' from generate_series(0, 6) weekday`,
      [pro.businessId],
    );
    return pro;
  }

  it("phone 390: Modifier chips open their tab, ideas lead to theirs", async () => {
    const pro = await withHours("Cléo", "Eva");
    const { page, errors, consoleErrors } = await studioPage(
      pro,
      390,
      true,
      true,
    );
    await page.goto(`${APP}/app/site`);
    await saved(page);
    const pressed = (name: string) =>
      page
        .getByRole("navigation", { name: "Réglages" })
        .getByRole("button", { name, exact: true });

    // Her page shows "infos pratiques" (so its Modifier) once it has some.
    await page.getByRole("button", { name: "Infos", exact: true }).click();
    await page
      .getByLabel("Adresse", { exact: true })
      .fill("12 rue des Lilas, Lyon");
    await saved(page);
    // On a phone the studio's sheet covers her preview: she closes it, then
    // taps a section; the studio comes back on that section's tab.
    await page.getByRole("button", { name: "Fermer le studio" }).click();
    await page
      .getByRole("button", { name: "Modifier tes prestations" })
      .click();
    await expect
      .poll(attr(pressed("Prestations"), "aria-pressed"))
      .toBe("true");
    await page.getByRole("button", { name: "Fermer le studio" }).click();
    await page
      .getByRole("button", { name: "Modifier tes infos pratiques" })
      .click();
    await expect.poll(attr(pressed("Infos"), "aria-pressed")).toBe("true");

    // Folded by default; opened, never mandatory, each idea leads somewhere.
    const card = page.getByRole("button", { name: /Pour une page plus utile/ });
    expect(await card.getAttribute("aria-expanded")).toBe("false");
    await card.click();
    await page
      .getByText("Rien n’est obligatoire : ta page se publie telle quelle.")
      .waitFor();
    // Hours are set: no hours idea.
    expect(await page.getByRole("link", { name: "Mes horaires" }).count()).toBe(
      0,
    );
    await page
      .getByRole("button", { name: /^Compléter : Choisis une photo/ })
      .click();
    await expect.poll(attr(pressed("Photos"), "aria-pressed")).toBe("true");

    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "studio ideas");

    // « Comme mes clientes » on a phone: its title on its own line, and
    // Escape from inside her page closes it.
    await page.getByRole("button", { name: "Voir comme mes clientes" }).click();
    const view = page.getByRole("dialog", { name: "Comme mes clientes" });
    const title = view.getByText("Comme mes clientes", { exact: true });
    expect((await title.boundingBox())!.width).toBeGreaterThan(300);
    const inside = page.frameLocator('iframe[title^="Ta page"]');
    await inside
      .getByRole("button", { name: /Réserver/ })
      .first()
      .waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "client view on a phone");
    await capture(page, "p122-clientes-390");
    await inside.locator("body").click({ position: { x: 10, y: 400 } });
    await inside.locator("body").press("Escape");
    await view.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  it("the hours idea is a link to her hours while none are set", async () => {
    const pro = await professionalWithVisit("Dora", "Eva");
    const { page } = await studioPage(pro, 1280, false, true);
    await page.goto(`${APP}/app/site`);
    await saved(page);
    await page
      .getByRole("button", { name: /Pour une page plus utile/ })
      .click();
    expect(
      await page
        .getByRole("link", { name: "Mes horaires" })
        .getAttribute("href"),
    ).toBe("/app/settings/hours");
  });

  it("point 121: her links survive a change of universe", async () => {
    const pro = await withHours("Lisa", "Eva");
    const { page, errors } = await studioPage(pro, 390, true, true);
    await page.goto(`${APP}/app/site`);
    await saved(page);
    await page.getByRole("button", { name: "Infos", exact: true }).click();
    await page.getByRole("button", { name: "Ajouter un lien" }).click();
    await page.getByLabel("Adresse du lien 1").fill("@studio.test");
    await saved(page);
    expect(JSON.stringify((await draftOf(pro.businessId)).config)).toContain(
      "@studio.test",
    );

    await chooseUniverse(page, /Maison Alma/);
    await saved(page);
    expect((await draftOf(pro.businessId)).config).toMatchObject({
      universe: "alma",
    });
    await page.getByRole("button", { name: "Infos", exact: true }).click();
    expect(await page.getByLabel("Adresse du lien 1").inputValue()).toBe(
      "@studio.test",
    );
    expect(JSON.stringify((await draftOf(pro.businessId)).config)).toContain(
      "@studio.test",
    );
    expect(errors).toEqual([]);
  });

  it("desktop 1280: her page as her clients see it, booking walked, never taken", async () => {
    const pro = await withHours("Maya", "Eva");
    const { page, errors, consoleErrors } = await studioPage(
      pro,
      1280,
      false,
      true,
    );
    await page.goto(`${APP}/app/site`);
    await saved(page);
    await page.getByRole("button", { name: "Voir comme mes clientes" }).click();
    const dialog = page.getByRole("dialog", { name: "Comme mes clientes" });
    await dialog.waitFor();
    const iframe = page.locator('iframe[title^="Ta page"]');
    await expect.poll(attr(iframe, "style")).toMatch(/width: 390px/);
    const frame = page.frameLocator('iframe[title^="Ta page"]');
    await frame.getByText(`Atelier Maya`).first().waitFor();
    expect(await frame.getByRole("button", { name: /^Modifier/ }).count()).toBe(
      0,
    );

    await dialog.getByRole("button", { name: "Ordinateur" }).click();
    await expect
      .poll(
        attr(
          dialog.getByRole("button", { name: "Ordinateur" }),
          "aria-pressed",
        ),
      )
      .toBe("true");
    await expect.poll(attr(iframe, "style")).toMatch(/width: 1280px/);
    await frame.getByText("Atelier Maya").first().waitFor();

    // Her booking, walked to the review.
    await frame
      .locator("[data-header-action]")
      .getByRole("button", { name: "Réserver" })
      .click();
    const sheet = frame.getByRole("dialog", { name: /Réserver chez/ });
    await sheet.waitFor();
    await sheet.getByRole("button", { name: /Rehaussement de cils/ }).click();
    await sheet
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();
    // Her real slots: today may be over (past 20:00), then her next one
    // is offered, which leads to that day's slots.
    const slots = sheet.getByRole("list", { name: /^Créneaux du / });
    const next = sheet.getByRole("button", { name: /^Prochain créneau/ });
    await slots.or(next).first().waitFor();
    if (await next.isVisible()) await next.click();
    await slots.waitFor();
    await slots.getByRole("button").first().click();
    await sheet.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
    await sheet.getByLabel(/^Prénom/).fill("Inès");
    await sheet.getByLabel(/^Email/).fill("ines@client.test.local");
    await sheet.getByRole("button", { name: "Continuer" }).click();
    await sheet
      .getByRole("heading", { name: "Vérifiez et confirmez" })
      .waitFor();
    const confirm = sheet.getByRole("button", {
      name: "Confirmation désactivée dans l’aperçu",
    });
    expect(await confirm.isDisabled()).toBe(true);
    // Never taken: no client of that name was created.
    const { rows } = await db.query(
      "select 1 from public.clients where business_id = $1 and first_name = 'Inès'",
      [pro.businessId],
    );
    expect(rows).toHaveLength(0);

    await expectAccessible(page, "client view");
    // Escape goes to the document that holds the focus: the frame's own
    // page after she walked its booking. Back on the dialog, it closes it.
    await dialog
      .getByText("Ton brouillon, avec tes vraies prestations.")
      .click();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

// Higani point 16: her informative sections, written in Sections, shown in
// her preview at once, placed by the arrows under Signature.
describe("Studio: her informative sections (point 16)", () => {
  it("desktop 1280: added, written, saved, placed, withdrawn", async () => {
    const pro = await professionalWithVisit("Opale", "Eva");
    await db.query("select public.set_site_plan($1, 'signature')", [
      pro.businessId,
    ]);
    const { page, errors, consoleErrors } = await studioPage(
      pro,
      1280,
      false,
      true,
    );
    const studio = page.getByRole("dialog", { name: "Studio de création" });
    await page.goto(`${APP}/app/site`);
    await saved(page);
    await studio.getByRole("button", { name: "Sections", exact: true }).click();

    const kinds = () =>
      page
        .locator("[data-site-section]")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-site-section")),
        );
    expect(await kinds()).not.toContain("info");

    const group = studio.getByRole("group", {
      name: "Ajouter une section d’information",
    });
    for (const idea of [
      "Avant votre rendez-vous",
      "Déroulé d’une séance",
      "Questions fréquentes",
      "Mes engagements",
      "Autre titre",
    ])
      await group.getByRole("button", { name: idea }).waitFor();
    await group
      .getByRole("button", { name: "Avant votre rendez-vous" })
      .click();

    // Her text field is ready to type in.
    const text = studio.getByLabel("Texte", { exact: true });
    await text.waitFor();
    await page.waitForFunction(
      () => document.activeElement?.tagName === "TEXTAREA",
    );
    await page.keyboard.type("Venez les ongles nus.");
    await saved(page);
    expect(await studio.getByLabel("Titre", { exact: true }).inputValue()).toBe(
      "Avant votre rendez-vous",
    );

    // Her preview shows it, with her title and her text.
    const preview = page.locator('[data-site-section="info"]');
    await preview.waitFor();
    await preview
      .getByRole("heading", { name: "Avant votre rendez-vous" })
      .waitFor();
    await preview.getByText("Venez les ongles nus.").waitFor();
    let draft = (await draftOf(pro.businessId)).config as {
      infoSections: { id: string; title: string; text: string }[];
      presentation?: { order?: string[] };
    };
    expect(draft.infoSections).toEqual([
      expect.objectContaining({
        title: "Avant votre rendez-vous",
        text: "Venez les ongles nus.",
      }),
    ]);
    const key = `info:${draft.infoSections[0]!.id}`;
    // By default: after her scenes, before her practical infos.
    const placed = await kinds();
    expect(placed.indexOf("info")).toBeGreaterThan(placed.indexOf("services"));

    // Signature: the arrows move it, in her preview and in her draft.
    const at = placed.indexOf("info");
    await studio
      .getByRole("button", { name: "Monter Avant votre rendez-vous" })
      .click();
    await saved(page);
    await expect.poll(async () => (await kinds()).indexOf("info")).toBe(at - 1);
    draft = (await draftOf(pro.businessId)).config as typeof draft;
    expect(draft.presentation?.order).toContain(key);
    expect(draft.presentation!.order!.indexOf(key)).toBe(at - 1);
    await capture(page, "p16-studio-1280");

    // Withdrawn: gone from her preview, her draft and her order.
    await studio
      .getByRole("button", {
        name: "Retirer cette section : Avant votre rendez-vous",
      })
      .click();
    await saved(page);
    await expect.poll(kinds).not.toContain("info");
    draft = (await draftOf(pro.businessId)).config as typeof draft;
    expect(draft.infoSections ?? []).toEqual([]);
    expect(JSON.stringify(draft.presentation?.order ?? [])).not.toContain(
      "info:",
    );

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  // WCAG 2.5.3 (label in name), as axe checks it on the open card.
  it("desktop 1280: her section's card is accessible, its Retirer button included", async () => {
    const pro = await professionalWithVisit("Opale", "Eva");
    const { page } = await studioPage(pro, 1280, false, true);
    const studio = page.getByRole("dialog", { name: "Studio de création" });
    await page.goto(`${APP}/app/site`);
    await saved(page);
    await studio.getByRole("button", { name: "Sections", exact: true }).click();
    await studio
      .getByRole("group", { name: "Ajouter une section d’information" })
      .getByRole("button", { name: "Avant votre rendez-vous" })
      .click();
    await studio.getByLabel("Texte", { exact: true }).fill("Venez à jeun.");
    await saved(page);
    await expectAccessible(page, "studio, her informative section");
  });
});
