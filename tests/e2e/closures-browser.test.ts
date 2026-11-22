import { expect, it } from "vitest";

import { addDaysToLocalDate } from "@/lib/time/local-date";

import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

it("closes one Monday and a separate week, preserving other dates and existing appointments", async () => {
  const pro = await professionalWithVisit("Lina", "Camille");
  await db.query(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
     select $1, weekday, '09:00', '18:00' from generate_series(0, 6) weekday`,
    [pro.businessId],
  );
  const {
    rows: [fixture],
  } = await db.query<{
    slug: string;
    service_id: string;
    today: string;
    monday: string;
  }>(
    `select b.slug, s.id service_id, d.today::text today,
            (d.today + (8 - extract(dow from d.today)::int) % 7 + 7)::text monday
     from public.businesses b join public.services s on s.business_id = b.id
     cross join lateral (select (now() at time zone b.timezone)::date today) d
     where b.id = $1`,
    [pro.businessId],
  );
  const monday = fixture!.monday;
  const nextMonday = addDaysToLocalDate(monday, 7);
  const breakStart = addDaysToLocalDate(monday, 14);
  const breakEnd = addDaysToLocalDate(breakStart, 6);
  const dayAfterBreak = addDaysToLocalDate(breakEnd, 1);
  await db.query(
    "insert into public.business_date_hours (business_id, date, starts_at, ends_at) values ($1, $2, '10:00', '13:00')",
    [pro.businessId, breakStart],
  );
  const slotCount = async (date: string) => {
    const response = await fetch(
      `${APP}/api/public/businesses/${fixture!.slug}/availability?` +
        new URLSearchParams({ serviceId: fixture!.service_id, date }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { slots: unknown[] } }).data
      .slots.length;
  };
  expect(await slotCount(breakStart)).toBeGreaterThan(0);

  const { page, errors } = await signedInPage(pro.browser, {
    appearance: null,
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/settings/hours`);
  const plan = await hydrated(
    page.getByRole("button", { name: "Planifier une fermeture" }),
  );
  const start = page.getByLabel("Premier jour fermé");
  const end = page.getByLabel("Dernier jour fermé (inclus)");
  const save = page.getByRole("button", { name: "Enregistrer la fermeture" });
  await plan.click();
  await start.fill(fixture!.today);
  await save.click();
  // Booked today: the appointments to decide on first (point 101), then back.
  await page
    .getByRole("region", { name: "Rendez-vous sur ces dates" })
    .waitFor();
  await page.getByRole("button", { name: "Retour" }).click();
  await start.fill(monday);
  expect(await end.inputValue()).toBe(monday);
  await save.click();
  await page.getByText("Fermeture enregistrée.").waitFor();
  expect(await slotCount(monday)).toBe(0);
  expect(await slotCount(nextMonday)).toBeGreaterThan(0);

  await plan.click();
  await start.fill(breakStart);
  await end.fill(breakEnd);
  await save.click();
  await page.getByText("Fermeture enregistrée.").waitFor();
  const dates = Array.from({ length: 7 }, (_, index) =>
    addDaysToLocalDate(breakStart, index),
  );
  expect(await Promise.all(dates.map(slotCount))).toEqual(Array(7).fill(0));
  expect(await slotCount(dayAfterBreak)).toBeGreaterThan(0);
  expect(await noSideScroll(page)).toBe(true);

  await page.reload();
  await page
    .getByRole("list", { name: "Fermetures prévues" })
    .getByRole("listitem")
    .last()
    .getByRole("button", { name: "Retirer la fermeture" })
    .click();
  await page
    .getByRole("dialog", { name: "Retirer cette fermeture ?" })
    .getByRole("button", { name: "Retirer la fermeture" })
    .click();
  await page.getByText("Fermeture retirée.").waitFor();
  expect(await slotCount(breakStart)).toBeGreaterThan(0);
  expect(await slotCount(monday)).toBe(0);
  expect(errors).toEqual([]);
});
