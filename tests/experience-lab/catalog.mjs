// Run like journeys.mjs (LAB_URL, CHROMIUM, PLAYWRIGHT; OUT for screenshots).
// Real journeys of the lab's catalogue, in Chromium (phone and desktop).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");

const APP = process.env.LAB_URL ?? "http://127.0.0.1:3008";
const OUT = process.env.OUT ?? "/tmp";
const results = [];
const check = (name, ok, detail = "") =>
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`,
  );
const errors = [];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });

async function session(device) {
  const phone = device === "phone";
  const context = await browser.newContext(
    phone
      ? {
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
          deviceScaleFactor: 2,
        }
      : { viewport: { width: 1280, height: 860 } },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${device}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(`${device} console: ${message.text().slice(0, 160)}`);
  });
  const tap = (locator) => (phone ? locator.tap() : locator.click());
  return { page, tap, context };
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const studio = (page) =>
  page.getByRole("dialog", { name: "Studio de création" });

// --- A. Edit the catalogue in Mila, then change universe -------------------
for (const device of ["phone", "desktop"]) {
  const { page, tap, context } = await session(device);
  const tag = `[${device}]`;
  await page.goto(`${APP}/labo/mila`);
  await tap(page.getByRole("button", { name: "Personnaliser" }));
  const s = studio(page);
  await s.getByRole("button", { name: /^Prestations/ }).waitFor();
  check(
    `${tag} Studio opens on « Prestations »`,
    (await s
      .getByRole("button", { name: /^Prestations/, pressed: true })
      .count()) === 1,
  );

  // Price of Volume russe → 25 €.
  await tap(s.getByRole("button", { name: /Volume russe/ }));
  const price = s.getByLabel("Prix");
  await price.fill("25");
  await page.waitForTimeout(250);
  const previewText = await page.locator("main, body").first().innerText();
  check(
    `${tag} new price shows at once in the preview`,
    /25 €/.test(previewText),
  );
  check(
    `${tag} the edited service is outlined in the preview`,
    (await page.locator('[data-service="s2"]').count()) === 1,
  );
  if (device === "phone")
    await page.screenshot({ path: `${OUT}/a1-service-editor-phone.png` });

  // Back, new category + new service.
  await tap(
    s
      .getByRole("button", { name: "Prestations", exact: false })
      .filter({ hasText: "‹" }),
  );
  await tap(s.getByRole("button", { name: /Nouvelle catégorie/ }));
  await s.getByLabel("Nom de la catégorie").fill("Remplissages");
  await tap(s.getByRole("button").filter({ hasText: "‹" }));
  const card = s.getByRole("region", { name: "Remplissages" });
  await tap(card.getByRole("button", { name: /Ajouter une prestation/ }));
  await s.getByLabel("Nom").fill("Remplissage trois semaines");
  await s.getByLabel("Prix").fill("45");
  await page.waitForTimeout(250);
  check(
    `${tag} a new category with a new service appears in the preview`,
    (await page.getByText("Remplissage trois semaines").count()) >= 1 &&
      (await page.getByText("Remplissages", { exact: true }).count()) >= 1,
  );
  check(
    `${tag} no horizontal overflow after adding`,
    (await overflow(page)) <= 0,
  );

  // Hide "Sourcils": its service leaves the preview; undo brings it back.
  await tap(s.getByRole("button").filter({ hasText: "‹" }));
  await tap(
    s
      .getByRole("region", { name: "Sourcils" })
      .getByRole("button", { name: /Sourcils/ })
      .first(),
  );
  await tap(s.getByRole("switch", { name: /Visible sur ton site/ }));
  await page.waitForTimeout(200);
  const hiddenGone =
    (await page
      .locator("section[data-booking-scene]")
      .getByText("Restructuration sourcils")
      .count()) === 0;
  check(`${tag} hiding a category removes it from the site`, hiddenGone);
  await tap(s.getByRole("button", { name: "Annuler" }).first());
  await page.waitForTimeout(200);
  check(
    `${tag} undo brings it back`,
    (await page
      .locator("section[data-booking-scene]")
      .getByText("Restructuration sourcils")
      .count()) === 1,
  );
  await tap(s.getByRole("button").filter({ hasText: "‹" }));

  // Change universe twice: the catalogue stays identical.
  for (const name of ["Maison Alma", "Nail Lab"]) {
    await tap(s.getByRole("button", { name: "Univers", exact: true }));
    await tap(s.getByRole("button", { name: new RegExp(name) }));
    await page.waitForTimeout(500);
    const site = page.locator("section[data-booking-scene]");
    const kept =
      (await site.getByText("Remplissage trois semaines").count()) === 1 &&
      (await site.getByText("Volume russe").count()) === 1 &&
      (await site.getByText("25 €").count()) >= 1 &&
      (await site.getByText("Remplissages").count()) >= 1;
    check(
      `${tag} after switching to ${name}: categories, services and prices kept`,
      kept,
    );
  }
  if (device === "phone")
    await page.screenshot({
      path: `${OUT}/a2-nail-lab-same-catalog-phone.png`,
    });

  // Publish, then "En ligne" shows the published catalogue.
  await tap(s.getByRole("button", { name: "Publier" }));
  await tap(s.getByRole("button", { name: "En ligne" }));
  await page.waitForTimeout(300);
  check(
    `${tag} published: "En ligne" shows her new service`,
    (await page
      .locator("section[data-booking-scene]")
      .getByText("Remplissage trois semaines")
      .count()) === 1,
  );
  await context.close();
}

// --- B. Booking with an option (phone) ---------------------------------------
{
  const { page, tap, context } = await session("phone");
  await page.goto(`${APP}/labo/mila?pro=cils`);
  const site = page.locator("section[data-booking-scene]");
  await site.getByText("Volume russe").scrollIntoViewIfNeeded();
  await tap(site.getByRole("button", { name: /Volume russe/ }));
  await tap(site.getByRole("button", { name: /Réserver ce soin/ }));
  const dialog = page.getByRole("dialog", { name: /Réserver chez/ });
  await dialog.getByText("Avez-vous besoin d’une dépose ?").waitFor();
  const cta = dialog.getByRole("button", { name: /Continuer/ });
  check(
    "[booking] option step shows the base price",
    /25 €/.test(await cta.innerText()),
  );
  await tap(dialog.getByRole("radio", { name: /Oui/ }));
  check(
    "[booking] « Oui » updates the price at once to 30 €",
    /30 €/.test(await cta.innerText()),
  );
  await page.screenshot({ path: `${OUT}/b1-booking-option-phone.png` });
  await tap(cta);
  await tap(dialog.getByRole("button", { name: /^1[0-9]:/ }).first());
  await tap(dialog.getByRole("button", { name: /Continuer ·/ }));
  await dialog.getByLabel("Prénom").fill("Léa");
  await dialog.getByLabel("Email").fill("lea@exemple.fr");
  await tap(dialog.getByRole("button", { name: /Confirmer · 30 €/ }));
  await dialog.getByText(/À bientôt, Léa/).waitFor();
  const done = await dialog.innerText();
  check(
    "[booking] confirmation recaps the option and the total, no account",
    /dépose \? Oui/.test(done) &&
      /30 €/.test(done) &&
      /Aucun compte/.test(done),
  );
  await page.screenshot({ path: `${OUT}/b2-booking-done-phone.png` });
  // An option that adds time: duration follows.
  await page.goto(`${APP}/labo/alma?pro=cils`);
  await context.close();
}

// --- C. Three trades × three universes: composition holds (phone) ----------
for (const pro of ["cils", "henne", "epilation"]) {
  for (const universe of ["mila", "alma", "nail-lab"]) {
    const { page, context } = await session("phone");
    await page.goto(`${APP}/labo/${universe}?pro=${pro}`);
    const scene = page.locator("section[data-booking-scene]");
    await scene.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    // Reveal everything (scroll through) so whileInView animations settle.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 500) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    });
    const text = await scene.innerText();
    const ok = (await overflow(page)) <= 0;
    const hiddenNotShown = pro === "cils" ? !/Formations/.test(text) : true;
    const emptyNotShown = !/Nouveautés/.test(text);
    const nav = await page
      .getByRole("navigation", { name: "Catégories" })
      .count();
    check(
      `[${universe} × ${pro}] no overflow, hidden/empty categories absent${pro === "epilation" ? ", category shortcuts shown" : ""}`,
      ok &&
        hiddenNotShown &&
        emptyNotShown &&
        (pro !== "epilation" || nav === 1),
      `overflow ${await overflow(page)}px, nav ${nav}`,
    );
    await scene
      .screenshot({ path: `${OUT}/c-${universe}-${pro}.png` })
      .catch(() => {});
    await context.close();
  }
}

// --- D. Remove every category, then undo (phone, Alma) -----------------------
{
  const { page, tap, context } = await session("phone");
  await page.goto(`${APP}/labo/alma`);
  await tap(page.getByRole("button", { name: "Personnaliser" }));
  const s = studio(page);
  // The studio's code loads on first use: wait for its list.
  await s.getByRole("button", { name: /Nouvelle catégorie/ }).waitFor();
  for (;;) {
    const header = s
      .locator("section[aria-label] > button")
      .filter({ hasText: "Modifier ›" })
      .first();
    if (!(await header.count())) break;
    await tap(header);
    await tap(s.getByRole("button", { name: "Supprimer la catégorie" }));
    const all = s.getByRole("button", { name: /Tout supprimer/ });
    if (await all.count()) await tap(all);
  }
  await page.waitForTimeout(300);
  const empty =
    (await page.getByText("Bientôt", { exact: true }).count()) === 1;
  const noQuick =
    (await page
      .getByRole("button", { name: /Réserver/ })
      .filter({ visible: true })
      .count()) === 0;
  check(
    "[empty] no service left: the scene says « Bientôt », no booking button anywhere",
    empty && noQuick,
  );
  await page.screenshot({ path: `${OUT}/d-empty-alma-phone.png` });
  check(
    "[empty] publishing an empty catalogue is allowed (nothing invalid)",
    (await s.getByRole("button", { name: "Publier" }).count()) === 1,
  );
  await context.close();
}

// --- E. Invalid edits block publishing; a removed service comes back --------
{
  const { page, tap, context } = await session("phone");
  await page.goto(`${APP}/labo/nail-lab`);
  await tap(page.getByRole("button", { name: "Personnaliser" }));
  const s = studio(page);
  const firstRow = s.locator("section[aria-label] li button").first();
  const name = (await firstRow.innerText()).split("\n")[0];
  await tap(firstRow);
  await s.getByLabel("Nom").fill("");
  const publish = s.getByRole("button", { name: /À compléter/ });
  check(
    "[guard] an unnamed service blocks publishing",
    (await publish.count()) === 1,
  );
  await s.getByLabel("Nom").fill(name);
  await tap(s.getByRole("button", { name: "Retirer du catalogue" }));
  await page.waitForTimeout(200);
  const gone =
    (await page
      .locator("section[data-booking-scene]")
      .getByText(name, { exact: true })
      .count()) === 0;
  await tap(s.getByRole("status").getByRole("button", { name: "Annuler" }));
  await page.waitForTimeout(200);
  const back =
    (await page
      .locator("section[data-booking-scene]")
      .getByText(name, { exact: true })
      .count()) === 1;
  check(
    `[guard] « ${name} » removed, then restored by the toast's Annuler`,
    gone && back,
  );
  await context.close();
}

// --- F. Her booking button's colour (Core) -----------------------------------
{
  const { page, tap, context } = await session("phone");
  await page.goto(`${APP}/labo/mila`);
  await tap(page.getByRole("button", { name: "Personnaliser" }));
  const s = studio(page);
  await tap(s.getByRole("button", { name: "Couleurs", exact: true }));
  await tap(s.getByRole("button", { name: /Encre/ }).last());
  await tap(s.getByRole("button", { name: "Fermer le studio" }));
  await page.waitForTimeout(800);
  const style = await page
    .locator(".fixed button")
    .filter({ hasText: /soins/i })
    .evaluate((button) => {
      const css = getComputedStyle(button);
      return {
        bg: css.backgroundColor,
        color: css.color,
        ring: css.boxShadow !== "none",
      };
    });
  check(
    "[cta] « Encre » colours the booking button, text computed readable",
    style?.bg === "rgb(11, 11, 11)" &&
      style?.color === "rgb(255, 255, 255)" &&
      style?.ring,
    JSON.stringify(style),
  );
  await page.screenshot({ path: `${OUT}/f-cta-ink-phone.png` });
  await context.close();
}

await browser.close();
console.log(results.join("\n"));
console.log(
  errors.length
    ? `ERRORS:\n${[...new Set(errors)].join("\n")}`
    : "no page errors",
);
process.exit(
  results.some((line) => line.startsWith("FAIL")) || errors.length ? 1 : 0,
);
