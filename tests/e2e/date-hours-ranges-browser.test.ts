import { expect, it } from "vitest";

import { addDaysToLocalDate } from "@/lib/time/local-date";

import { capture } from "./support/capture";
import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// A tester's report of 21/11 (Higani point 219), on her phone, in the real
// settings page: usually open 18:00–20:00, she adds 10:00–12:00 for one
// date. The editor starts from her usual 18:00–20:00, so both are kept and
// both are offered online that day; a usual range can also be removed for
// that date only, and restoring the usual hours brings the day back.

it("adds a range to a date's usual hours, keeps both online, removes one, then restores the usual day", async () => {
  const pro = await professionalWithVisit("Lina", "Camille");
  await db.query(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
     select $1, weekday, '18:00', '20:00' from generate_series(0, 6) weekday`,
    [pro.businessId],
  );
  await db.query(
    "update public.business_settings set slot_interval_minutes = 30 where business_id = $1",
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
  const date = addDaysToLocalDate(fixture!.today, 10);
  // Her service lasts 75 minutes: a 2-hour range offers 2 starts.
  const slots = async () => {
    const response = await fetch(
      `${APP}/api/public/businesses/${fixture!.slug}/availability?` +
        new URLSearchParams({ serviceId: fixture!.service_id, date }),
    );
    expect(response.status).toBe(200);
    return (
      (await response.json()) as {
        data: { slots: { localStartsAt: string }[] };
      }
    ).data.slots.map((slot) => slot.localStartsAt.slice(11, 16));
  };
  expect(await slots()).toEqual(["18:00", "18:30"]);

  const { page, errors } = await signedInPage(pro.browser, {
    appearance: null,
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/settings/hours`);
  const dateInput = await hydrated(page.getByLabel("Date à modifier"));
  await dateInput.fill(date);

  // Her usual range is already there: she adds hers.
  await page
    .getByText(/Tes horaires habituels du .+ sont déjà remplis/)
    .waitFor();
  expect(
    await page.getByLabel("Début de la plage 1", { exact: true }).inputValue(),
  ).toBe("18:00");
  expect(
    await page.getByLabel("Fin de la plage 1", { exact: true }).inputValue(),
  ).toBe("20:00");
  await page
    .getByRole("button", { name: "Ajouter une plage", exact: true })
    .click();
  await page
    .getByLabel("Début de la plage 2", { exact: true })
    .selectOption("10:00");
  await page
    .getByLabel("Fin de la plage 2", { exact: true })
    .selectOption("12:00");
  expect(await noSideScroll(page)).toBe(true);
  await capture(page, "date-hours-01-added-to-usual");

  // An overlap is explained before anything is sent.
  await page
    .getByLabel("Fin de la plage 2", { exact: true })
    .selectOption("18:30");
  await page.getByText("Deux plages se chevauchent.").waitFor();
  expect(
    await page
      .getByRole("button", { name: "Enregistrer cette date" })
      .isDisabled(),
  ).toBe(true);
  await page
    .getByLabel("Fin de la plage 2", { exact: true })
    .selectOption("12:00");

  await page.getByRole("button", { name: "Enregistrer cette date" }).click();
  await page.getByText("Horaires enregistrés pour cette date.").waitFor();
  const { rows } = await db.query<{ starts_at: string; ends_at: string }>(
    `select to_char(starts_at, 'HH24:MI') starts_at, to_char(ends_at, 'HH24:MI') ends_at
       from public.business_date_hours where business_id = $1 and date = $2
      order by starts_at`,
    [pro.businessId, date],
  );
  expect(rows).toEqual([
    { starts_at: "10:00", ends_at: "12:00" },
    { starts_at: "18:00", ends_at: "20:00" },
  ]);
  expect(await slots()).toEqual(["10:00", "10:30", "18:00", "18:30"]);
  await page.getByText(/Horaires personnalisés pour cette date/).waitFor();
  await page.getByText(/Prochaines dates personnalisées \(1\)/).click();
  await page.getByText("10:00 – 12:00 · 18:00 – 20:00").waitFor();
  await capture(page, "date-hours-02-saved");

  // A usual range removed for that date only (saved sorted: 18:00 is 2nd).
  expect(
    await page.getByLabel("Début de la plage 2", { exact: true }).inputValue(),
  ).toBe("18:00");
  await page
    .getByRole("button", { name: "Retirer la plage 2", exact: true })
    .click();
  await page.getByRole("button", { name: "Enregistrer cette date" }).click();
  // (The same success message is still on screen from the first save.)
  await expect.poll(slots).toEqual(["10:00", "10:30"]);
  await page.getByText("10:00 – 12:00", { exact: true }).waitFor();

  await page
    .getByRole("button", { name: "Rétablir les horaires habituels" })
    .click();
  await page.getByText("Horaires habituels rétablis.").waitFor();
  expect(await slots()).toEqual(["18:00", "18:30"]);
  // Back to her usual range, ready to be edited again.
  expect(
    await page.getByLabel("Début de la plage 1", { exact: true }).inputValue(),
  ).toBe("18:00");
  expect(errors).toEqual([]);
});
