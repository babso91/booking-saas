import { expect, it } from "vitest";

import { addDaysToLocalDate } from "@/lib/time/local-date";

import { capture } from "./support/capture";
import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Higani point 222: the minimum notice of online bookings was chosen at
// onboarding only. She now changes it in « Horaires », on her phone, and
// the public slots follow the server's rule at once.

it("changes the minimum notice after onboarding, and the public slots follow it", async () => {
  const pro = await professionalWithVisit("Lina", "Camille");
  await db.query(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
     select $1, weekday, '08:00', '20:00' from generate_series(0, 6) weekday`,
    [pro.businessId],
  );
  const {
    rows: [fixture],
  } = await db.query<{ slug: string; service_id: string; today: string }>(
    `select b.slug, s.id service_id,
            ((now() at time zone b.timezone)::date)::text today
       from public.businesses b join public.services s on s.business_id = b.id
      where b.id = $1`,
    [pro.businessId],
  );
  const slotCount = async (days: number) => {
    const response = await fetch(
      `${APP}/api/public/businesses/${fixture!.slug}/availability?` +
        new URLSearchParams({
          serviceId: fixture!.service_id,
          date: addDaysToLocalDate(fixture!.today, days),
        }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { slots: unknown[] } }).data
      .slots.length;
  };
  // Onboarding's 2 hours: tomorrow is bookable.
  expect(await slotCount(1)).toBeGreaterThan(0);

  const { page, errors } = await signedInPage(pro.browser, {
    appearance: null,
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/settings/hours`);
  const notice = await hydrated(page.getByLabel("Préavis", { exact: true }));
  expect(await notice.inputValue()).toBe("120");
  await page.getByText("Réservable en ligne jusqu’à 2 h avant.").waitFor();

  await notice.selectOption({ label: "2 jours" });
  await page.getByText("Réservable en ligne jusqu’à 2 jours avant.").waitFor();
  await page.getByRole("button", { name: "Enregistrer le préavis" }).click();
  await page.getByText("Préavis enregistré.").waitFor();
  expect(await noSideScroll(page)).toBe(true);
  await capture(page, "booking-notice-saved");

  const { rows } = await db.query<{ minutes: number }>(
    "select minimum_booking_notice_minutes minutes from public.business_settings where business_id = $1",
    [pro.businessId],
  );
  expect(rows[0]!.minutes).toBe(2880);
  // Nothing bookable within 2 days any more; three days ahead still is.
  expect(await slotCount(1)).toBe(0);
  expect(await slotCount(3)).toBeGreaterThan(0);

  // Kept after a reload, and back to the last minute.
  await page.reload();
  const reloaded = await hydrated(page.getByLabel("Préavis", { exact: true }));
  expect(await reloaded.inputValue()).toBe("2880");
  await reloaded.selectOption("0");
  await page.getByRole("button", { name: "Enregistrer le préavis" }).click();
  await page.getByText("Préavis enregistré.").waitFor();
  expect(await slotCount(1)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
