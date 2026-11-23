import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Points 146 and 182 in a real browser: the private link of her export,
// opened the way the export screen opens it (window.location.assign), is a
// real download from her session; without that session it gives nothing.

it("downloads her client file from her session, and nothing without it", async () => {
  const pro = await professionalWithVisit("Nora", "Inès");
  const jobId = randomUUID();
  // An export she asked for (crm_export_request, covered in integration).
  await db.query(
    `insert into public.crm_export_jobs
       (id, business_id, request_id, scope, status, expires_at, row_count)
     values ($1, $2, $3, 'contacts', 'ready', now() + interval '24 hours', 1)`,
    [jobId, pro.businessId, randomUUID()],
  );
  const url = `${APP}/api/crm-export/${jobId}`;

  // No session: refused, nothing counted.
  expect((await fetch(url)).status).toBe(401);

  const { page, errors } = await signedInPage(pro.browser, {
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/clients`, { waitUntil: "load" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate((link) => window.location.assign(link), url),
  ]);
  const {
    rows: [business],
  } = await db.query<{ slug: string; today: string }>(
    `select b.slug, to_char(now() at time zone b.timezone, 'YYYY-MM-DD') today
     from public.businesses b where b.id = $1`,
    [pro.businessId],
  );
  expect(download.suggestedFilename()).toBe(
    `clientes-${business!.slug}-${business!.today}.csv`,
  );
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString("utf8").split("\r\n");
  expect(lines[0]).toBe(
    "Prénom;Nom;E-mail;Téléphone;Fiche créée le;Visites passées;Dernière visite;Prochain rendez-vous",
  );
  expect(lines.filter((line) => line.startsWith("Inès;"))).toHaveLength(1);

  const {
    rows: [job],
  } = await db.query<{ download_count: number }>(
    "select download_count from public.crm_export_jobs where id = $1",
    [jobId],
  );
  expect(job!.download_count).toBe(1);
  expect(errors).toEqual([]);
  await page.context().close();
});
