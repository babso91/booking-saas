// axe-core (WCAG 2.1 A/AA) on the lab's real screens: each universe at
// 320, 390 and 1440 px, every booking step, the studio's panels. Run like
// journeys.mjs. axe-core is the copy pinned in ./vendor (version and
// SHA-256 below, checked before every run; AXE=path overrides it). The
// site header is drawn in mix-blend-mode: difference, whose colours axe
// cannot compute: colour-contrast results on blended elements are set
// apart in the page (before any truncation) and reported, not counted.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");
const APP = process.env.LAB_URL ?? "http://127.0.0.1:3008";

// axe-core 4.14.0 (MPL-2.0), from the npm package's axe.min.js.
const AXE_VERSION = "4.14.0";
const AXE_SHA256 =
  "20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878";
const AXE =
  process.env.AXE ??
  fileURLToPath(
    new URL(`./vendor/axe-core-${AXE_VERSION}.min.js`, import.meta.url),
  );
if (!process.env.AXE) {
  const sum = createHash("sha256").update(readFileSync(AXE)).digest("hex");
  if (sum !== AXE_SHA256)
    throw new Error(`axe-core ${AXE_VERSION}: checksum mismatch`);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const report = [];

async function audit(page, label, include) {
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(async (scope) => {
    const run = await axe.run(
      scope ? document.querySelector(scope) : document,
      {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
        resultTypes: ["violations"],
      },
    );
    // Colours under mix-blend-mode cannot be computed by axe: set apart.
    const blended = (target) => {
      for (
        let node = document.querySelector(target[0]);
        node;
        node = node.parentElement
      ) {
        if (getComputedStyle(node).mixBlendMode !== "normal") return true;
      }
      return false;
    };
    return run.violations.map((v) => {
      const kept =
        v.id === "color-contrast"
          ? v.nodes.filter((n) => !blended(n.target))
          : v.nodes;
      return {
        id: v.id,
        impact: v.impact,
        help: v.help,
        blend: v.nodes.length - kept.length,
        nodes: kept
          .slice(0, 4)
          .map((n) =>
            `${n.target.join(" ")} :: ${(n.failureSummary || "").split("\n")[1] ?? ""}`.slice(
              0,
              220,
            ),
          ),
        count: kept.length,
      };
    });
  }, include ?? null);
  report.push({ label, result });
}

async function reveal(page) {
  for (let y = 0; y < 12000; y += 250) {
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

for (const id of ["mila", "alma", "nail-lab"]) {
  for (const width of [320, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(`${APP}/labo/${id}?pro=epilation`);
    await page.waitForTimeout(1200);
    await reveal(page);
    await audit(page, `${id}: site ${width}px (épilation)`);
    await context.close();
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(`${APP}/labo/${id}?pro=cils`);
  await page.waitForTimeout(1200);
  await reveal(page);
  await audit(page, `${id}: site`);

  // Booking, every step.
  await page
    .locator("header button")
    .filter({ hasText: /Réserver/i })
    .click();
  const dialog = page.getByRole("dialog", { name: /Réserver chez/ });
  await dialog.waitFor();
  await page.waitForTimeout(700);
  await audit(page, `${id}: booking — service`);
  await dialog.getByRole("button", { name: /Volume russe/ }).click();
  await page.waitForTimeout(1200);
  await audit(page, `${id}: booking — options`);
  await dialog.getByRole("button", { name: /Continuer/ }).click();
  await page.waitForTimeout(1200);
  await dialog
    .getByRole("button", { name: /^1[0-9]:/ })
    .first()
    .click();
  await audit(page, `${id}: booking — slot`);
  await dialog.getByRole("button", { name: /Continuer ·/ }).click();
  await page.waitForTimeout(1200);
  await dialog.getByRole("button", { name: /Confirmer/ }).click();
  await page.waitForTimeout(300);
  await audit(page, `${id}: booking — contact with errors`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  if (id === "mila") {
    await page.getByRole("button", { name: "Personnaliser" }).click();
    const s = page.getByRole("dialog", { name: "Studio de création" });
    await page.waitForTimeout(600);
    await audit(page, "studio: prestations (list)");
    await s.getByRole("button", { name: /Volume russe/ }).click();
    await page.waitForTimeout(1200);
    await audit(page, "studio: service editor");
    for (const tab of [
      "Sections",
      "Couleurs",
      "Partager",
      "Textes",
      "Photos",
    ]) {
      await s.getByRole("button", { name: tab, exact: true }).click();
      await page.waitForTimeout(400);
      await audit(page, `studio: ${tab}`);
    }
  }
  await context.close();
}

await browser.close();
let violations = 0;
let blendNodes = 0;
for (const entry of report) {
  for (const v of entry.result) blendNodes += v.blend;
  entry.result = entry.result.filter((v) => v.count > 0);
  violations += entry.result.length;
}
for (const { label, result } of report) {
  console.log(
    `\n== ${label}: ${result.length ? result.map((v) => `${v.id}(${v.count})`).join(", ") : "OK"}`,
  );
  for (const v of result) {
    console.log(`  [${v.impact}] ${v.id} — ${v.help}`);
    for (const node of v.nodes) console.log(`     ${node}`);
  }
}
console.log(
  `\naxe-core ${AXE_VERSION}: ${report.length} screens, ${violations} violation(s); ${blendNodes} colour-contrast node(s) under mix-blend-mode set apart (not computable)`,
);
process.exit(violations ? 1 : 0);
