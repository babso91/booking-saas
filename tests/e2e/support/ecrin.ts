import { createRequire } from "node:module";

import {
  chromium,
  type Browser as Chromium,
  type Locator,
  type Page,
} from "playwright";
import { afterAll, beforeAll, expect, vi } from "vitest";

import { APP, wear, type Browser } from "./studio";

// Shared by the Écrin browser tests: a real browser, signed in, in a style.

export const look = (style: string, mode = "light") =>
  `atelier.${mode}.standard.-.${style}`;
export const ECRIN = look("ecrin");

let chrome: Chromium;
beforeAll(async () => {
  chrome = await chromium.launch();
});
afterAll(() => chrome.close());

type Options = {
  width?: number;
  height?: number;
  phone?: boolean;
  /** What her account holds (default: Écrin); null: nothing set up. */
  appearance?: string | null;
  /** The cookie an old version of the app left on this device. */
  legacyCookie?: string;
};

/** A page signed in as this professional, whose account holds this look. */
export async function signedInPage(browser: Browser, options: Options = {}) {
  const { width = 1280, height = 800, phone = false } = options;
  const appearance =
    options.appearance === undefined ? ECRIN : options.appearance;
  if (appearance !== null) await wear(browser, appearance);
  const context = await chrome.newContext({
    viewport: { width, height },
    isMobile: phone,
    hasTouch: phone,
  });
  const host = new URL(APP).hostname;
  await context.addCookies([
    ...[...browser.cookies].map(([name, value]) => ({
      name,
      value,
      url: APP,
    })),
    // Where the app itself wrote it: a second one at "/" would shadow it.
    ...(options.legacyCookie === undefined
      ? []
      : [
          {
            name: "dash_appearance",
            value: encodeURIComponent(options.legacyCookie),
            domain: host,
            path: "/app",
          },
        ]),
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors };
}

/** Waits until React answers on this element: a click now really counts. */
export async function hydrated(locator: Locator) {
  // Found again on each try: hydration may replace the element.
  await vi.waitFor(
    async () =>
      expect(
        await locator.evaluate((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      ).toBe(true),
    { timeout: 15_000, interval: 50 },
  );
  return locator;
}

/** The style really applied, read in the live page. */
export const applied = (page: Page) =>
  page.evaluate(() => ({
    style: document.documentElement.getAttribute("data-style"),
    frame: document.querySelectorAll(".ecrin-ground").length,
    heading: getComputedStyle(document.querySelector("h1") ?? document.body)
      .fontFamily,
  }));

export const noSideScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** axe-core (WCAG 2.1 AA, contrast included) on the page as it stands. */
export async function expectAccessible(page: Page, what: string) {
  // Measured at rest: a panel still sliding in blends its colours.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const { axe } = window as unknown as {
      axe: {
        run: (
          context: Document,
          options: object,
        ) => Promise<{
          violations: {
            id: string;
            nodes: { target: unknown[]; failureSummary?: string }[];
          }[];
        }>;
      };
    };
    const { violations } = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      // WCAG 2.5.3, outside those tags: what she sees is in what she can say.
      rules: { "label-content-name-mismatch": { enabled: true } },
    });
    return violations.map(
      ({ id, nodes }) =>
        `${id}: ${nodes
          .slice(0, 3)
          .map(
            (node) =>
              `${node.target.join(" ")} ${node.failureSummary?.slice(0, 160) ?? ""}`,
          )
          .join(" | ")}`,
    );
  });
  expect(violations, what).toEqual([]);
}
