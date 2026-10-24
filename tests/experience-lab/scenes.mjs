// Run like journeys.mjs (LAB_URL, CHROMIUM, PLAYWRIGHT; OUT for screenshots).
// Portrait, sections, share, booking modal: real journeys (phone).
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
const phone = async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on(
    "console",
    (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)),
  );
  return { page, context };
};
const settle = (page) =>
  page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
  });

// Portrait in each universe.
for (const id of ["mila", "alma", "nail-lab"]) {
  const { page, context } = await phone();
  await page.goto(`${APP}/labo/${id}`);
  await settle(page);
  const heading = page
    .getByRole("heading", { level: 2 })
    .filter({ hasText: /^(Mila|Alma|Nina)$/ });
  await heading.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  const section = page.locator("section").filter({ has: heading });
  check(
    `[${id}] portrait scene shows her name and words`,
    (await heading.count()) === 1,
  );
  check(
    `[${id}] no overflow`,
    (await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    )) <= 0,
  );
  await section.screenshot({ path: `${OUT}/portrait-${id}.png` });
  await context.close();
}

// Sections: hide the portrait in Core, it leaves the site and survives a universe change.
{
  const { page, context } = await phone();
  await page.goto(`${APP}/labo/mila?pro=henne`);
  await page.getByRole("button", { name: "Personnaliser" }).tap();
  const s = page.getByRole("dialog", { name: "Studio de création" });
  await s.getByRole("button", { name: "Sections", exact: true }).tap();
  check(
    "[sections] opening and services are locked",
    (await s.getByRole("switch", { disabled: true }).count()) === 2,
  );
  await s.getByRole("switch", { name: /Portrait/ }).tap();
  await page.waitForTimeout(300);
  check(
    "[sections] hidden portrait leaves the site",
    (await page.getByText("Prénom Exemple").count()) === 0,
  );
  await s.getByRole("button", { name: "Univers", exact: true }).tap();
  await s.getByRole("button", { name: /Maison Alma/ }).tap();
  await page.waitForTimeout(500);
  check(
    "[sections] still hidden after switching to Alma",
    (await page.getByText("Prénom Exemple").count()) === 0,
  );
  await s.getByRole("button", { name: "Sections", exact: true }).tap();
  await s.getByRole("switch", { name: /Portrait/ }).tap();
  await page.waitForTimeout(300);
  check(
    "[sections] shown again, with the pro's own words",
    (await page.getByText("Prénom Exemple").count()) >= 1,
  );

  // Share: link without any key, QR drawn, copy works.
  await s.getByRole("button", { name: "Partager", exact: true }).tap();
  const link = await s.getByLabel("Ton lien").inputValue();
  check(
    "[share] the link is the page's public address",
    link === `${APP}/labo/mila?pro=henne` ||
      link === `${APP}/labo/alma?pro=henne`,
    link,
  );
  check(
    "[share] the QR code is drawn",
    (await s.locator("svg path").count()) >= 1,
  );
  await s.getByRole("button", { name: "Copier le lien" }).tap();
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("[share] « Copier le lien » copies it", clip === link);
  await page.screenshot({ path: `${OUT}/share-phone.png` });
  const downloads = page.waitForEvent("download");
  await s.getByRole("button", { name: "Image PNG" }).tap();
  const file = await downloads;
  check(
    "[share] PNG download",
    /^qr-.*\.png$/.test(file.suggestedFilename()),
    file.suggestedFilename(),
  );
  await context.close();
}

// Share link never carries the lab key.
{
  const { page, context } = await phone();
  await page.goto(`${APP}/labo/nail-lab?cle=SECRET123&pro=cils`);
  await page.getByRole("button", { name: "Personnaliser" }).tap();
  const s = page.getByRole("dialog", { name: "Studio de création" });
  await s.getByRole("button", { name: "Partager", exact: true }).tap();
  const link = await s.getByLabel("Ton lien").inputValue();
  check(
    "[share] an access key in the address is never in the shared link",
    !link.includes("SECRET") && link.endsWith("/labo/nail-lab?pro=cils"),
    link,
  );
  await context.close();
}

// Booking modal: background inert, Tab stays inside, focus returns.
{
  const { page, context } = await (async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    return { page, context };
  })();
  await page.goto(`${APP}/labo/alma`);
  const opener = page.locator("header button").filter({ hasText: /Réserver/i });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /Réserver chez/ });
  await dialog.waitFor();
  const inert = await page.evaluate(
    () =>
      [...document.body.children].filter((e) => e.hasAttribute("inert")).length,
  );
  check(
    "[booking] the page and the studio behind are inert",
    inert >= 1,
    `${inert} inert`,
  );
  let inside = true;
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    inside &&= await page.evaluate(
      () =>
        !!document.activeElement?.closest('[role="dialog"][aria-modal="true"]'),
    );
  }
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Shift+Tab");
    inside &&= await page.evaluate(
      () =>
        !!document.activeElement?.closest('[role="dialog"][aria-modal="true"]'),
    );
  }
  check("[booking] Tab and Shift+Tab never leave the booking", inside);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  const back = await page.evaluate(() =>
    document.activeElement?.textContent?.trim(),
  );
  const after = await page.evaluate(
    () =>
      [...document.body.children].filter((e) => e.hasAttribute("inert")).length,
  );
  check(
    "[booking] closed: focus back on « Réserver », nothing left inert",
    /Réserver/i.test(back ?? "") && after === 0,
    `${back} / ${after}`,
  );
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
