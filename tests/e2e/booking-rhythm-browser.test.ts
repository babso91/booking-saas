import { expect, it } from "vitest";

import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Points 220–222 in a real browser, on a phone: she opens her Mondays at
// 9:05, offers a slot every 5 minutes without notice, and her public
// calendar follows at once.

const SCREENSHOT = process.env.RHYTHM_SCREENSHOT;

it("opens at 9:05 and offers a slot every 5 minutes from the hours page", async () => {
  const pro = await professionalWithVisit("Maya", "Jade");
  await db.query(
    `update public.business_settings
     set slot_interval_minutes = 15, minimum_booking_notice_minutes = 120,
         buffer_minutes = 0
     where business_id = $1`,
    [pro.businessId],
  );
  await db.query(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
     select $1, weekday, '09:00', '12:00' from generate_series(0, 6) weekday`,
    [pro.businessId],
  );
  const {
    rows: [fixture],
  } = await db.query<{
    slug: string;
    service_id: string;
    monday: string;
    tuesday: string;
  }>(
    `select b.slug, s.id service_id, m.monday::text, (m.monday + 1)::text as tuesday
     from public.businesses b join public.services s on s.business_id = b.id
     cross join lateral (select (now() at time zone b.timezone)::date today) d
     cross join lateral (
       select d.today + 2 + ((8 - extract(isodow from d.today + 2)::int) % 7) monday
     ) m
     where b.id = $1`,
    [pro.businessId],
  );
  const firstSlots = async (date: string) => {
    const response = await fetch(
      `${APP}/api/public/businesses/${fixture!.slug}/availability?` +
        new URLSearchParams({ serviceId: fixture!.service_id, date }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { slots: { localStartsAt: string }[] };
    };
    return body.data.slots
      .slice(0, 3)
      .map((slot) => slot.localStartsAt.slice(11, 16));
  };
  expect(await firstSlots(fixture!.monday)).toEqual([
    "09:00",
    "09:15",
    "09:30",
  ]);

  const { page, errors } = await signedInPage(pro.browser, {
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/settings/hours`);

  // Point 221: 9:05 is one of the choices of her week.
  const monday = await hydrated(
    page.getByLabel("Début de la plage 1, Lundi", { exact: true }),
  );
  await monday.selectOption("09:05");
  await page.getByRole("button", { name: "Enregistrer les horaires" }).click();
  await page.getByText("Horaires enregistrés.").waitFor();

  // Points 220 and 222: her rhythm.
  const interval = page.getByLabel("Créneaux proposés", { exact: true });
  expect(await interval.inputValue()).toBe("15");
  await interval.selectOption({ label: "Toutes les 5 min" });
  await page
    .getByText("Si tu ouvres à 9 h : 9 h 00, 9 h 05, 9 h 10…")
    .waitFor();
  await page
    .getByLabel("Préavis minimum", { exact: true })
    .selectOption({ label: "Aucun : jusqu’à la dernière minute" });
  await page.getByRole("button", { name: "Enregistrer le rythme" }).click();
  const saved = page.getByText(/^Rythme enregistré\./);
  await saved.waitFor();
  if (SCREENSHOT) {
    await page
      .getByRole("heading", { name: "Rythme des réservations" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: SCREENSHOT });
  }

  expect(await firstSlots(fixture!.monday)).toEqual([
    "09:05",
    "09:10",
    "09:15",
  ]);
  expect(await firstSlots(fixture!.tuesday)).toEqual([
    "09:00",
    "09:05",
    "09:10",
  ]);

  await page.reload();
  expect(
    await (
      await hydrated(page.getByLabel("Créneaux proposés", { exact: true }))
    ).inputValue(),
  ).toBe("5");
  expect(
    await page.getByLabel("Préavis minimum", { exact: true }).inputValue(),
  ).toBe("0");
  expect(
    await page
      .getByLabel("Début de la plage 1, Lundi", { exact: true })
      .inputValue(),
  ).toBe("09:05");
  expect(await noSideScroll(page)).toBe(true);
  expect(errors).toEqual([]);
  await page.context().close();
});
