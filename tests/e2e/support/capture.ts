import { mkdirSync } from "node:fs";

import type { Page } from "playwright";

// What a screen really looked like in CI, with real data: saved for review
// (uploaded as an artifact), never compared. Changes nothing in the test.

const DIR = "test-results/screens";

export async function capture(page: Page, what: string) {
  mkdirSync(DIR, { recursive: true });
  const file = what.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase();
  await page.screenshot({ path: `${DIR}/${file}.png` });
}
