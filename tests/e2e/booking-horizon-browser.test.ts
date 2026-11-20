import { expect, it } from "vitest";

import { hydrated, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

it("opens the public calendar from one month to two months from the hours page", async () => {
  const pro = await professionalWithVisit("Lina", "Camille");
  await db.query(
    "update public.business_settings set maximum_booking_advance_days = 30 where business_id = $1",
    [pro.businessId],
  );
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
    within: string;
    beyond: string;
  }>(
    `select b.slug, s.id service_id, (d.today + 45)::text as within,
            (d.today + 61)::text as beyond
     from public.businesses b join public.services s on s.business_id = b.id
     cross join lateral (select (now() at time zone b.timezone)::date today) d
     where b.id = $1`,
    [pro.businessId],
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
  expect(await slotCount(fixture!.within)).toBe(0);

  const { page, errors } = await signedInPage(pro.browser, {
    appearance: null,
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/settings/hours`);
  const horizon = await hydrated(
    page.getByLabel("Délai maximum", { exact: true }),
  );
  expect(await horizon.inputValue()).toBe("30");
  await horizon.selectOption({ label: "2 mois (60 jours)" });
  await page.getByRole("button", { name: "Enregistrer le délai" }).click();
  await page.getByText("Délai de réservation enregistré.").waitFor();
  expect(await slotCount(fixture!.within)).toBeGreaterThan(0);
  expect(await slotCount(fixture!.beyond)).toBe(0);
  await page.reload();
  expect(await horizon.inputValue()).toBe("60");
  expect(errors).toEqual([]);
});
