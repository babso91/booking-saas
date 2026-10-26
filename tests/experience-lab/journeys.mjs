// Real journeys of the Experience Engine lab in Chromium: one case per
// audit finding (I1–I8, m1–m5) plus the core journeys. Each case drives
// the real pages (no mock of the engine) and asserts what a professional
// or a customer would see. Run against a lab server (dev or production
// build with LAB_PUBLIC=1):
//
//   LAB_URL=http://127.0.0.1:3008 CHROMIUM=/path/to/chromium \
//     node tests/experience-lab/journeys.mjs [case-id …]
//
// `playwright-core` is resolved from PLAYWRIGHT (a path to the package),
// else from node_modules. Exit code 1 when a case fails.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");

const APP = process.env.LAB_URL ?? "http://127.0.0.1:3008";
const only = process.argv.slice(2);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
});

const phone = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};
const small = {
  viewport: { width: 320, height: 640 },
  hasTouch: true,
  isMobile: true,
};
const desktop = { viewport: { width: 1280, height: 860 } };

async function open(path, device = phone, extra = {}) {
  const context = await browser.newContext({ ...device, ...extra });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${APP}${path}`);
  await page.waitForLoadState("networkidle");
  return { context, page, errors };
}

const studioOf = (page) =>
  page.getByRole("dialog", { name: "Studio de création" });
async function openStudio(page) {
  await page.getByRole("button", { name: "Personnaliser" }).click();
  const studio = studioOf(page);
  await studio.waitFor();
  await page.waitForTimeout(450); // its sheet slides in
  return studio;
}
const bookingOf = (page) => page.getByRole("dialog", { name: /Réserver chez/ });
const inertCount = (page) =>
  page.evaluate(
    () =>
      [...document.body.children].filter((element) =>
        element.hasAttribute("inert"),
      ).length,
  );
const cases = [
  {
    id: "I1",
    name: "booking opened while the studio is open: on top, fully usable, the studio comes back after",
    async run(check) {
      const { context, page } = await open("/labo/mila");
      const studio = await openStudio(page);
      await studio.getByRole("button", { name: "En ligne" }).click();
      const opener = page
        .locator("header button")
        .filter({ hasText: /Réserver/i });
      await opener.click();
      const booking = bookingOf(page);
      await booking.waitFor();
      await page.waitForTimeout(700);
      // Chromium's hit testing skips inert elements: what is SEEN on top
      // is the stacking order, checked here, then a real click.
      const layers = await page.evaluate(() => {
        // The layer an element is painted in: its outermost z-index.
        const z = (element) => {
          let layer = 0;
          for (
            let node = element;
            node && node !== document.body;
            node = node.parentElement
          ) {
            const value = Number(getComputedStyle(node).zIndex);
            if (Number.isFinite(value)) layer = value;
          }
          return layer;
        };
        const studio = document.querySelector(
          '[aria-label="Studio de création"]',
        );
        const booking = document.querySelector(
          '[role="dialog"][aria-modal="true"]',
        );
        return {
          studio: studio ? z(studio) : null,
          booking: booking ? z(booking) : null,
          studioVisible: studio
            ? getComputedStyle(studio).visibility !== "hidden"
            : false,
        };
      });
      check(
        "the booking is stacked above the studio (or the studio is hidden)",
        !layers.studioVisible || (layers.booking ?? 0) > (layers.studio ?? 0),
        JSON.stringify(layers),
      );
      await booking.getByRole("button", { name: /Volume russe/ }).click();
      const option = booking.getByText("Avez-vous besoin d’une dépose ?");
      await option.waitFor({ timeout: 5000 }).catch(() => {});
      check(
        "a service of the list can be chosen",
        (await option.count()) === 1,
      );
      await page.keyboard.press("Escape");
      await booking.waitFor({ state: "detached" });
      await page.waitForTimeout(300);
      check(
        "closed: nothing left inert, scroll unlocked",
        (await inertCount(page)) === 0 &&
          (await page.evaluate(() => document.body.style.overflow)) === "",
      );
      check(
        "the studio is back as it was (En ligne)",
        (await studio
          .getByRole("button", { name: "En ligne", pressed: true })
          .count()) === 1,
      );
      await context.close();
    },
  },
  {
    id: "I2",
    name: "an invalid price or supplement blocks publishing, never publishes the former value",
    async run(check) {
      const { context, page } = await open("/labo/mila");
      const studio = await openStudio(page);
      await studio.getByRole("button", { name: /Pose cil à cil/ }).click();
      await studio
        .getByRole("textbox", { name: "Prix", exact: true })
        .fill("-12");
      await studio
        .getByRole("textbox", { name: "Nom", exact: true })
        .fill("Pose cil à cil renommée");
      const publish = studio.getByRole("button", {
        name: /Publier|À compléter/,
      });
      check(
        "the publish button says what is missing",
        /À compléter/.test(await publish.innerText()),
        await publish.innerText(),
      );
      // « À compléter » leads to the list, the blocking fields on top.
      await publish.click();
      const blocking = studio.getByRole("region", { name: "À compléter" });
      check(
        "the field that blocks is named (her service, its price)",
        /Pose cil à cil renommée.*prix à corriger/s.test(
          await blocking.innerText(),
        ),
        await blocking.innerText(),
      );
      await studio.getByRole("button", { name: "En ligne" }).click();
      await page.waitForTimeout(300);
      const site = page.locator("section[data-booking-scene]");
      check(
        "nothing was published (the old name is still online)",
        (await site.getByText("Pose cil à cil renommée").count()) === 0 &&
          (await site.getByText("Pose cil à cil").count()) === 1,
      );
      await studio.getByRole("button", { name: /^Brouillon/ }).click();
      await blocking.getByRole("button").first().click();
      check(
        "the draft keeps her edits, the price field as she typed it",
        (await studio
          .getByRole("textbox", { name: "Nom", exact: true })
          .inputValue()) === "Pose cil à cil renommée" &&
          (await studio
            .getByRole("textbox", { name: "Prix", exact: true })
            .inputValue()) === "-12",
      );
      for (const value of ["", "abc"]) {
        await studio
          .getByRole("textbox", { name: "Prix", exact: true })
          .fill(value);
        check(
          `price « ${value} » blocks too`,
          /À compléter/.test(await publish.innerText()),
        );
      }
      await studio
        .getByRole("textbox", { name: "Prix", exact: true })
        .fill("95");
      // A supplement typed wrong blocks as well.
      await studio.getByRole("button", { name: /Ajouter une option/ }).click();
      await studio.getByLabel("Question").fill("Une question ?");
      await studio.getByLabel("Supplément, réponse 2").fill("-5");
      check(
        "an invalid supplement blocks publishing",
        /À compléter/.test(await publish.innerText()),
      );
      await studio.getByLabel("Supplément, réponse 2").fill("5");
      check(
        "all valid again: publishable",
        /^Publier/.test(await publish.innerText()),
        await publish.innerText(),
      );
      await context.close();
    },
  },
  {
    id: "I3",
    name: "a photo opened from the preview while in Prestations shows its editor, and back returns to the services",
    async run(check) {
      const { context, page } = await open("/labo/mila");
      const studio = await openStudio(page);
      // Touched where it shows, above the studio's sheet.
      await page
        .getByRole("button", { name: "Modifier la photo de couverture" })
        .click({ position: { x: 120, y: 160 } });
      await page.waitForTimeout(300);
      check(
        "the photo editor is shown",
        (await studio
          .getByRole("slider", { name: "Point focal de la photo" })
          .count()) === 1,
      );
      await studio
        .getByRole("slider", { name: "Point focal de la photo" })
        .focus();
      await page.keyboard.press("ArrowRight");
      await studio.getByRole("button", { name: "Annuler" }).click();
      await studio
        .getByRole("button", { name: /Retour|Réglages|‹/ })
        .first()
        .click();
      await page.waitForTimeout(200);
      check(
        "back: the settings tabs and the services list",
        (await studio.getByRole("navigation", { name: "Réglages" }).count()) ===
          1 &&
          (await studio
            .getByRole("button", { name: /Pose cil à cil/ })
            .count()) === 1,
      );
      await context.close();
    },
  },
  {
    id: "I4",
    name: "the full-screen gallery is a real modal (focus, Tab, Escape, inert, scroll, focus back)",
    async run(check) {
      for (const device of [desktop, phone]) {
        const label = device === phone ? "phone" : "desktop";
        const { context, page } = await open("/labo/mila", device);
        const first = page
          .locator("section ul li button")
          .filter({ has: page.locator("img") })
          .first();
        await first.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await first.focus();
        await page.keyboard.press("Enter");
        const gallery = page
          .locator('[role="dialog"][aria-modal="true"]')
          .first();
        await gallery.waitFor();
        await page.waitForTimeout(500);
        check(
          `${label}: focus moved into the gallery`,
          await page.evaluate(
            () => !!document.activeElement?.closest('[role="dialog"]'),
          ),
        );
        let inside = true;
        for (let i = 0; i < 8; i += 1) {
          await page.keyboard.press("Tab");
          inside &&= await page.evaluate(
            () => !!document.activeElement?.closest('[role="dialog"]'),
          );
        }
        check(`${label}: Tab stays inside`, inside);
        check(
          `${label}: the page behind is inert and does not scroll`,
          (await inertCount(page)) >= 1 &&
            (await page.evaluate(() => document.body.style.overflow)) ===
              "hidden",
        );
        await page.keyboard.press("Escape");
        await page.waitForTimeout(700);
        check(
          `${label}: Escape closes it`,
          (await page.locator('[role="dialog"][aria-modal="true"]').count()) ===
            0,
        );
        check(
          `${label}: focus back on the photo that opened it, nothing inert`,
          (await first.evaluate(
            (element) => element === document.activeElement,
          )) && (await inertCount(page)) === 0,
        );
        await context.close();
      }
    },
  },
  {
    id: "I5",
    name: "the published site follows the current plan, and Signature settings come back without republishing",
    async run(check) {
      const bloom = (page) => page.locator("h1 span.inline-block").count();
      for (const universe of ["mila", "nail-lab"]) {
        const { context, page } = await open(`/labo/${universe}`);
        const studio = await openStudio(page);
        await studio
          .getByRole("button", { name: "Créatif", exact: true })
          .click();
        await studio
          .getByRole("button", { name: "Composition", exact: true })
          .click();
        await studio
          .getByRole("button", { name: "Éclosion", exact: true })
          .click();
        await studio.getByRole("button", { name: "Publier" }).click();
        await studio.getByRole("button", { name: "En ligne" }).click();
        await page.waitForTimeout(400);
        check(
          `${universe}: Signature published, online: Éclosion`,
          (await bloom(page)) > 0,
        );
        for (const [plan, expected] of [
          ["Simple", false],
          ["Créatif", true],
          ["Simple", false],
          ["Créatif", true],
        ]) {
          await studio.getByRole("button", { name: plan, exact: true }).click();
          await page.waitForTimeout(400);
          check(
            `${universe}: online after → ${plan}: ${expected ? "Éclosion" : "the universe's opening"}`,
            (await bloom(page)) > 0 === expected,
          );
        }
        await studio.getByRole("button", { name: /^Brouillon/ }).click();
        await studio
          .getByRole("button", { name: "Simple", exact: true })
          .click();
        await page.waitForTimeout(400);
        check(
          `${universe}: draft in Simple: the universe's opening`,
          (await bloom(page)) === 0,
        );
        await studio
          .getByRole("button", { name: "Créatif", exact: true })
          .click();
        await page.waitForTimeout(400);
        check(
          `${universe}: draft back in Créatif: Éclosion kept`,
          (await bloom(page)) > 0,
        );
        await context.close();
      }
    },
  },
  {
    id: "I6",
    name: "sharing says it is a temporary demo; the booking says nothing is sent",
    async run(check) {
      const { context, page } = await open("/labo/mila?cle=SECRET&pro=cils");
      const studio = await openStudio(page);
      await studio
        .getByRole("button", { name: "Univers", exact: true })
        .click();
      await studio.getByRole("button", { name: /Maison Alma/ }).click();
      await studio
        .getByRole("button", { name: "Partager", exact: true })
        .click();
      const text = await studio.innerText();
      check(
        "the panel says it is a temporary demo",
        /démonstration temporaire/i.test(text),
      );
      check(
        "…that her changes in this tab are not sent",
        /ne (sont|seront) pas transmis/i.test(text),
      );
      check(
        "…and that no real booking or email follows",
        /aucune réservation réelle/i.test(text) && /aucun email/i.test(text),
      );
      const link = await studio.getByLabel("Ton lien").inputValue();
      check(
        "the link opens the universe shown, never the key",
        link.endsWith("/labo/alma?pro=cils") && !link.includes("SECRET"),
        link,
      );
      await studio.getByRole("button", { name: "Fermer le studio" }).click();
      await page
        .locator("header button")
        .filter({ hasText: /Réserver/i })
        .click();
      const booking = bookingOf(page);
      await booking.getByRole("button", { name: /Volume russe/ }).click();
      await booking.getByRole("button", { name: /Continuer/ }).click();
      await booking
        .getByRole("button", { name: /^1[0-9]:/ })
        .first()
        .click();
      await booking.getByRole("button", { name: /Continuer ·/ }).click();
      await booking.getByLabel("Prénom").fill("Léa");
      await booking.getByLabel("Email").fill("lea@exemple.fr");
      await booking.getByRole("button", { name: /Confirmer/ }).click();
      await booking.getByText(/À bientôt/).waitFor();
      const done = await booking.innerText();
      check(
        "the confirmation says it is simulated, no email sent",
        /simulation/i.test(done) &&
          /aucun email/i.test(done) &&
          !/Un email de confirmation part/.test(done),
      );
      await context.close();
    },
  },
  {
    id: "I8",
    name: "a customer never downloads the studio until it is opened",
    async run(check) {
      const { context, page } = await open("/labo/alma");
      const before = new Set();
      page.on(
        "request",
        (request) =>
          request.resourceType() === "script" && before.add(request.url()),
      );
      await page.waitForTimeout(1500);
      const scripts = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter(
            (entry) =>
              entry.initiatorType === "script" || entry.name.endsWith(".js"),
          )
          .map((entry) => entry.name),
      );
      const loadedBefore = new Set(scripts);
      const after = [];
      page.on(
        "request",
        (request) =>
          request.resourceType() === "script" && after.push(request.url()),
      );
      await page.getByRole("button", { name: "Personnaliser" }).click();
      await studioOf(page).waitFor();
      const fresh = after.filter((url) => !loadedBefore.has(url));
      check(
        "opening Personnaliser downloads the studio's code (it was not loaded before)",
        fresh.length >= 1,
        `${fresh.length} new script(s)`,
      );
      await context.close();
    },
  },
  {
    id: "m1",
    name: "reduced motion: no scroll-driven parallax",
    async run(check) {
      const { context, page } = await open("/labo/mila", phone, {
        reducedMotion: "reduce",
      });
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(600);
      const transform = await page.evaluate(
        () =>
          getComputedStyle(document.querySelector("section .sticky")).transform,
      );
      check(
        "the cover frame does not scale with the scroll",
        transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)",
        transform,
      );
      await context.close();
    },
  },
  {
    id: "m2",
    name: "undo restores the universe in Simple",
    async run(check) {
      const { context, page } = await open("/labo/mila");
      const studio = await openStudio(page);
      await studio
        .getByRole("button", { name: "Univers", exact: true })
        .click();
      await studio.getByRole("button", { name: /Maison Alma/ }).click();
      await page.waitForTimeout(300);
      await studio.getByRole("button", { name: "Annuler" }).click();
      await page.waitForTimeout(400);
      check(
        "Mila is chosen again",
        (await studio
          .getByRole("button", { name: /Studio Mila/, pressed: true })
          .count()) === 1,
      );
      check(
        "Mila's opening is back",
        (await page.locator("h1.overflow-hidden").count()) === 1,
      );
      await context.close();
    },
  },
  {
    id: "m3",
    name: "320 px: the studio's actions fit; the Photo badge never covers the header name",
    async run(check) {
      for (const universe of ["mila", "alma"]) {
        const { context, page } = await open(`/labo/${universe}`, small);
        const studio = await openStudio(page);
        const right = await studio
          .getByRole("button", { name: /Publi/ })
          .evaluate((element) => element.getBoundingClientRect().right);
        check(
          `${universe}: the publish button fits in 320 px`,
          right <= 320,
          String(right),
        );
        const overlap = await page.evaluate(() => {
          const badge = [...document.querySelectorAll("span")].find(
            (element) => element.textContent?.trim() === "✎ Photo",
          );
          const name = document.querySelector(
            "header span, header [style*='--t-display']",
          );
          if (!badge || !name) return -1;
          const a = badge.getBoundingClientRect();
          const b = name.getBoundingClientRect();
          return (
            Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
          );
        });
        check(
          `${universe}: the Photo badge does not cover the name`,
          overlap === 0,
          String(overlap),
        );
        await context.close();
      }
      // No element wider than 320 px, whatever the catalogue.
      for (const universe of ["mila", "alma", "nail-lab"]) {
        for (const pro of ["henne", "epilation"]) {
          const { context, page } = await open(
            `/labo/${universe}?pro=${pro}`,
            small,
          );
          for (let y = 0; y < 12000; y += 400) {
            await page.mouse.wheel(0, 400);
            await page.waitForTimeout(30);
          }
          await page.waitForTimeout(800);
          // Past the screen's edge, and not inside a scroller or a clip
          // that itself fits (shelves, chips and bands scroll on purpose).
          const wide = await page.evaluate(() => {
            const inside = (element) => {
              for (
                let node = element.parentElement;
                node && node !== document.body;
                node = node.parentElement
              ) {
                const overflow = getComputedStyle(node).overflowX;
                if (
                  overflow !== "visible" &&
                  node.getBoundingClientRect().right <= window.innerWidth + 0.01
                )
                  return true;
              }
              return false;
            };
            const past = [...document.querySelectorAll("body *")].filter(
              (element) => {
                if (getComputedStyle(element).position === "fixed")
                  return false;
                const rect = element.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.right > window.innerWidth + 0.01 &&
                  rect.left < window.innerWidth &&
                  !inside(element)
                );
              },
            );
            return (
              past.length +
              (document.documentElement.scrollWidth > window.innerWidth
                ? 1000
                : 0)
            );
          });
          check(
            `${universe} × ${pro}: nothing runs past 320 px`,
            wide === 0,
            `${wide} element(s)`,
          );
          await context.close();
        }
      }
    },
  },
  {
    id: "m4",
    name: "the booking (a portal) uses the universe's body face",
    async run(check) {
      const { context, page } = await open("/labo/mila");
      await page
        .locator("header button")
        .filter({ hasText: /Réserver/i })
        .click();
      const booking = bookingOf(page);
      await booking.waitFor();
      const family = await booking.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      check(
        "Mila's booking text is in Inter Tight",
        /Inter Tight/i.test(family),
        family,
      );
      await context.close();
    },
  },
  {
    id: "J1",
    name: "Alma's service cards read on the surface really shown (Fond jour #707070, Texte jour #FFFFFF)",
    async run(check) {
      const { context, page } = await open("/labo/alma");
      const studio = await openStudio(page);
      await studio
        .getByRole("button", { name: "Créatif", exact: true })
        .click();
      await studio
        .getByRole("button", { name: "Couleurs", exact: true })
        .click();
      await studio.getByLabel("Fond jour").fill("#707070");
      await studio.getByLabel("Texte jour").fill("#ffffff");
      await studio.getByRole("button", { name: /^Publier/ }).click();
      await studio.getByRole("button", { name: "En ligne" }).click();
      await studio.getByRole("button", { name: "Fermer le studio" }).click();
      const card = page.locator("section[data-booking-scene] article").first();
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(2500);
      // Every text node of the cards against the colour it is drawn on.
      const ratios = await page.evaluate(() => {
        // rgb(…) or, for color-mix(), color(srgb r g b) in 0–1.
        const rgb = (value) => {
          const numbers = (value.match(/[\d.]+/g) ?? []).map(Number);
          if (value.startsWith("color(srgb")) {
            const [r, g, b, a = 1] = numbers;
            return [r * 255, g * 255, b * 255, a];
          }
          return numbers.slice(0, 4);
        };
        const lum = ([r, g, b]) => {
          const c = [r, g, b].map((v) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const ratio = (a, b) => {
          const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        };
        const background = (element) => {
          for (let node = element; node; node = node.parentElement) {
            const [r, g, b, a = 1] = rgb(
              getComputedStyle(node).backgroundColor,
            );
            if (a > 0.99) return [r, g, b];
          }
          return [255, 255, 255];
        };
        const out = [];
        for (const article of document.querySelectorAll(
          "section[data-booking-scene] article",
        )) {
          const walker = document.createTreeWalker(
            article,
            NodeFilter.SHOW_TEXT,
          );
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const element = text.parentElement;
            if (!text.textContent.trim() || element.closest("button")) continue;
            const style = getComputedStyle(element);
            const [r, g, b, a = 1] = rgb(style.color);
            const bg = background(element);
            const opacity = Number(style.opacity);
            const fg = [r, g, b].map(
              (v, i) => v * a * opacity + bg[i] * (1 - a * opacity),
            );
            out.push({
              text: text.textContent.trim().slice(0, 24),
              ratio: Number(ratio(fg, bg).toFixed(2)),
            });
          }
        }
        return out;
      });
      const worst = ratios.reduce(
        (min, item) => (item.ratio < min.ratio ? item : min),
        { ratio: 99 },
      );
      check(
        "every text of every card reads (4.5:1)",
        ratios.length > 0 && worst.ratio >= 4.5,
        JSON.stringify(worst),
      );
      await context.close();
    },
  },
  {
    id: "J2",
    name: "the services are visible without JavaScript, with JavaScript late, and revealed with JavaScript",
    async run(check) {
      const hidden = (page) =>
        page.evaluate(
          () =>
            [
              ...document.querySelectorAll(
                "section[data-booking-scene] h2, section[data-booking-scene] li, section[data-booking-scene] article, [data-reveal]",
              ),
            ].filter((element) => {
              const style = getComputedStyle(element);
              return (
                Number(style.opacity) < 0.99 ||
                /\b0%\)?$/.test(style.maskSize) ||
                style.maskSize === "100% 0%"
              );
            }).length,
        );
      for (const universe of ["mila", "alma", "nail-lab"]) {
        // No JavaScript at all.
        const off = await browser.newContext({
          ...phone,
          javaScriptEnabled: false,
        });
        const page = await off.newPage();
        await page.goto(`${APP}/labo/${universe}`);
        for (let y = 0; y < 9000; y += 600)
          await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(3000);
        const titles = await page
          .locator(
            "section[data-booking-scene] h2, section[data-booking-scene] li",
          )
          .count();
        check(
          `${universe}: without JavaScript, every service shown (${titles} elements)`,
          titles > 0 && (await hidden(page)) === 0,
          `${await hidden(page)} hidden`,
        );
        await off.close();

        // JavaScript held back 6 s: what is served is visible meanwhile.
        const late = await browser.newContext(phone);
        const slow = await late.newPage();
        await slow.route("**/_next/static/chunks/**", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 6000));
          await route.continue();
        });
        await slow.goto(`${APP}/labo/${universe}`, {
          waitUntil: "domcontentloaded",
        });
        await slow.waitForTimeout(2500);
        await slow
          .locator("section[data-booking-scene]")
          .scrollIntoViewIfNeeded();
        await slow.waitForTimeout(500);
        check(
          `${universe}: JavaScript late: services visible before hydration`,
          (await hidden(slow)) === 0,
          `${await hidden(slow)} hidden`,
        );
        await late.close();

        // JavaScript on: revealed on scroll, nothing left hidden at the end.
        const { context, page: live } = await open(`/labo/${universe}`);
        const armed = await live.evaluate(
          () => !!document.querySelector("[data-reveal-kind][class*='armed']"),
        );
        for (let y = 0; y < 12000; y += 300) {
          await live.mouse.wheel(0, 300);
          await live.waitForTimeout(60);
        }
        // What a customer looks at, sideways too (film strips, shelves).
        const count = await live.locator("[data-reveal]").count();
        for (let index = 0; index < count; index += 1) {
          await live
            .locator("[data-reveal]")
            .nth(index)
            .evaluate((element) =>
              element.scrollIntoView({ block: "center", inline: "center" }),
            );
          await live.waitForTimeout(120);
        }
        await live.waitForTimeout(2500);
        check(
          `${universe}: JavaScript on: reveals armed, all revealed after scrolling`,
          armed && (await hidden(live)) === 0,
          `${await hidden(live)} hidden`,
        );
        await context.close();
      }
    },
  },
  {
    id: "J3",
    name: "her local photos are released when the site goes away (navigation inside the app)",
    async run(check) {
      const context = await browser.newContext(phone);
      await context.addInitScript(() => {
        window.__made = [];
        window.__freed = [];
        const make = URL.createObjectURL.bind(URL);
        const free = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
          const url = make(blob);
          window.__made.push(url);
          return url;
        };
        URL.revokeObjectURL = (url) => {
          window.__freed.push(url);
          free(url);
        };
      });
      const page = await context.newPage();
      await page.goto(`${APP}/labo`);
      await page
        .getByRole("link", { name: /Studio Mila/ })
        .first()
        .click();
      await page.waitForURL(/\/labo\/mila/);
      const studio = await openStudio(page);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      await studio.getByRole("button", { name: "Photos", exact: true }).click();
      await studio.getByRole("button", { name: /Couverture/ }).click();
      await studio
        .locator('input[type="file"]')
        .setInputFiles({ name: "a.png", mimeType: "image/png", buffer: png });
      await page.waitForTimeout(300);
      await studio.getByRole("button", { name: "Annuler" }).click();
      await studio
        .locator('input[type="file"]')
        .setInputFiles({ name: "b.png", mimeType: "image/png", buffer: png });
      await page.waitForTimeout(300);
      await studio.getByRole("button", { name: /^Publier/ }).click();
      await studio.getByRole("button", { name: "Annuler" }).click();
      await page.waitForTimeout(300);
      await page.goBack();
      await page.waitForURL(/\/labo$/);
      await page.waitForTimeout(500);
      const { made, freed } = await page.evaluate(() => ({
        made: window.__made,
        freed: window.__freed,
      }));
      const kept = made.filter((url) => !freed.includes(url));
      check(
        "both photos were made, none is kept once the site is gone",
        made.length === 2 && kept.length === 0,
        JSON.stringify({ made: made.length, kept: kept.length }),
      );
      await context.close();
    },
  },
  {
    id: "J4",
    name: "the Price field stays in its column, next to Duration (320 to 1440 px)",
    async run(check) {
      for (const width of [320, 375, 390, 768, 1440]) {
        const device =
          width < 768
            ? {
                viewport: { width, height: 844 },
                hasTouch: true,
                isMobile: true,
              }
            : { viewport: { width, height: 900 } };
        const { context, page } = await open("/labo/mila", device);
        const studio = await openStudio(page);
        await studio.getByRole("button", { name: /Pose cil à cil/ }).click();
        const price = studio.getByRole("textbox", {
          name: "Prix",
          exact: true,
        });
        const duration = studio.getByRole("combobox", {
          name: "Durée",
          exact: true,
        });
        const geometry = await price.evaluate(
          (input, select) => {
            const a = input.getBoundingClientRect();
            const column =
              input
                .closest(".grid > div, .grid > *")
                ?.getBoundingClientRect() ?? a;
            const b = select.getBoundingClientRect();
            return {
              past: Math.round(a.right - column.right),
              overlap: Math.round(
                Math.max(
                  0,
                  Math.min(a.right, b.right) - Math.max(a.left, b.left),
                ) *
                  Math.max(
                    0,
                    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
                  ),
              ),
            };
          },
          await duration.elementHandle(),
        );
        check(
          `${width} px: Price within its column, not over Duration`,
          geometry.past <= 0 && geometry.overlap === 0,
          JSON.stringify(geometry),
        );
        await context.close();
      }
    },
  },
  {
    id: "J5",
    name: "an invalid price comes back as typed and flagged after Annuler then Rétablir",
    async run(check) {
      const { context, page } = await open("/labo/mila");
      const studio = await openStudio(page);
      await studio.getByRole("button", { name: /Pose cil à cil/ }).click();
      const price = studio.getByRole("textbox", { name: "Prix", exact: true });
      await price.fill("-12");
      await page.waitForTimeout(1000); // one undo step for the gesture
      await studio.getByRole("button", { name: "Annuler" }).click();
      check(
        "undone: 90, valid",
        (await price.inputValue()) === "90" &&
          (await price.getAttribute("aria-invalid")) === null,
      );
      await studio.getByRole("button", { name: "Rétablir" }).click();
      check(
        "redone: « -12 », flagged invalid",
        (await price.inputValue()) === "-12" &&
          (await price.getAttribute("aria-invalid")) === "true",
        `${await price.inputValue()} / ${await price.getAttribute("aria-invalid")}`,
      );
      check(
        "and the publish button still says what is missing",
        /À compléter/.test(
          await studio
            .getByRole("button", { name: /Publier|À compléter/ })
            .innerText(),
        ),
      );
      await context.close();
    },
  },
  {
    id: "J6",
    name: "every « ✎ Photo » button says « photo » in its name",
    async run(check) {
      const { context, page } = await open("/labo/mila");
      await openStudio(page);
      const names = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter(
            (button) =>
              button.textContent?.includes("Photo") &&
              button.getAttribute("aria-label"),
          )
          .map((button) => button.getAttribute("aria-label")),
      );
      check(
        `${names.length} button(s), all naming the photo`,
        names.length > 0 && names.every((name) => /photo/i.test(name)),
        JSON.stringify(names),
      );
      await context.close();
    },
  },
];

let failed = 0;
for (const item of cases) {
  if (only.length && !only.includes(item.id)) continue;
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  try {
    await item.run(check);
  } catch (error) {
    results.push({
      name: "ran to the end",
      ok: false,
      detail: String(error).split("\n").slice(0, 3).join(" | "),
    });
  }
  const bad = results.filter((result) => !result.ok);
  failed += bad.length ? 1 : 0;
  console.log(`${bad.length ? "FAIL" : "PASS"}  ${item.id} — ${item.name}`);
  for (const result of results)
    console.log(
      `        ${result.ok ? "ok  " : "FAIL"} ${result.name}${result.detail && !result.ok ? ` (${result.detail})` : ""}`,
    );
}
await browser.close();
process.exit(failed ? 1 : 0);
