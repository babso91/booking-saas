import { expect, it } from "vitest";

import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

it("shows the professional and public calendars on mobile and keeps the cancellation editor in a dialog", async () => {
  const pro = await professionalWithVisit("Lina", "Camille");
  await db.query(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
     select $1, weekday, '09:00', '18:00' from generate_series(0, 6) weekday`,
    [pro.businessId],
  );
  const {
    rows: [business],
  } = await db.query<{ slug: string }>(
    "select slug from public.businesses where id = $1",
    [pro.businessId],
  );

  const { page, errors } = await signedInPage(pro.browser, {
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/settings/hours`);
  const trigger = await hydrated(
    page.getByRole("button", { name: "Règle d’annulation", exact: true }),
  );
  const dialog = page.getByRole("dialog", { name: "Annulation en ligne" });
  expect(await dialog.count()).toBe(0);
  await trigger.click();
  await dialog.getByLabel("Autoriser l’annulation").waitFor();
  await dialog.getByRole("button", { name: "Fermer" }).click();
  await dialog.waitFor({ state: "hidden" });
  expect(await noSideScroll(page)).toBe(true);

  await page.goto(`${APP}/app`);
  const professionalViews = page.getByRole("navigation", {
    name: "Vue de l’agenda",
  });
  await (
    await hydrated(professionalViews.getByRole("button", { name: "Mois" }))
  ).click();
  const calendar = page.getByRole("region", {
    name: "Calendrier de l’agenda",
  });
  await calendar
    .getByRole("button", { name: /1 rendez-vous,/ })
    .first()
    .waitFor();
  await calendar.getByRole("button", { name: /Camille Visite/ }).waitFor();
  await calendar
    .getByText(/Libre dès /)
    .first()
    .waitFor();
  await professionalViews.getByRole("button", { name: "Semaine" }).click();
  expect(
    await professionalViews
      .getByRole("button", { name: "Semaine" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(await noSideScroll(page)).toBe(true);

  await page.context().clearCookies();
  await page.goto(`${APP}/b/${business!.slug}`);
  await (
    await hydrated(page.getByRole("button", { name: /Rehaussement de cils/ }))
  ).click();
  const publicViews = page.getByRole("navigation", {
    name: "Vue des disponibilités",
  });
  await publicViews.getByRole("button", { name: "Mois" }).click();
  await page.getByRole("button", { name: "Mois suivant" }).click();
  const availableDay = page
    .getByRole("button", {
      name: /, [1-9]\d* créneaux$/,
    })
    .first();
  await availableDay.click();
  expect(await availableDay.getAttribute("aria-pressed")).toBe("true");
  expect(await noSideScroll(page)).toBe(true);

  await publicViews.getByRole("button", { name: "Semaine" }).click();
  const slot = page.getByRole("button", { name: / à \d{2}:\d{2}$/ }).first();
  await slot.click();
  await page.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
  expect(errors).toEqual([]);
  await page.context().close();
});
