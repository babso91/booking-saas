import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser as Chromium } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.generated";

import { APP, db, env, professionalWithVisit } from "./support/studio";

// Her studio's photo preview (GET /api/sites/photos/:assetId/:width) in a
// real browser: one computer, one professional signs out, another signs in.
// The second must never be shown the first one's photo from the browser's
// cache (Codex audit): the preview is never stored.

let chrome: Chromium;
beforeAll(async () => {
  chrome = await chromium.launch();
});
afterAll(() => chrome.close());

const service = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** A ready photo of `businessId`, with its 480 px derivative in the bucket. */
async function readyPhoto(businessId: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.site_assets (business_id, status, content_type, byte_size, width, height)
     values ($1, 'ready', 'image/jpeg', 1000, 480, 640) returning id`,
    [businessId],
  );
  const id = rows[0]!.id;
  const image = await sharp({
    create: { width: 480, height: 640, channels: 3, background: "#a0522d" },
  })
    .webp()
    .toBuffer();
  const { error } = await service.storage
    .from("site-photos")
    .upload(`${businessId}/${id}/w480.webp`, image, {
      contentType: "image/webp",
    });
  if (error) throw error;
  return id;
}

describe("site photo preview in one browser, two professionals", () => {
  it("A sees her photo; after A leaves and B signs in, B gets nothing of it", async () => {
    const a = await professionalWithVisit("Anaïs", "Une");
    const b = await professionalWithVisit("Bérénice", "Deux");
    const assetId = await readyPhoto(a.businessId);
    const preview = `${APP}/api/sites/photos/${assetId}/480`;

    const context = await chrome.newContext();
    const page = await context.newPage();
    const fetchPreview = () =>
      page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: "include" });
        return {
          status: response.status,
          cache: response.headers.get("cache-control"),
        };
      }, preview);

    // A, signed in: her photo, never to be stored.
    await context.addCookies(
      [...a.browser.cookies].map(([name, value]) => ({
        name,
        value,
        url: APP,
      })),
    );
    await page.goto(`${APP}/login`);
    const seenByA = await fetchPreview();
    expect(seenByA.status).toBe(200);

    // A leaves; B signs in on the same browser (same cache).
    await context.clearCookies();
    await context.addCookies(
      [...b.browser.cookies].map(([name, value]) => ({
        name,
        value,
        url: APP,
      })),
    );
    await page.goto(`${APP}/login`);
    const seenByB = await fetchPreview();
    expect(seenByB.status).toBe(404);
    // Because the browser was told never to store it.
    expect(seenByA.cache).toBe("no-store");

    // Signed out: nothing either.
    await context.clearCookies();
    expect((await fetchPreview()).status).not.toBe(200);
    await context.close();
  });
});
