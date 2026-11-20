import { expect, it } from "vitest";

import { noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

it("adds, revisits and restores two different Thursdays independently", async () => {
  const pro = await professionalWithVisit("Lina", "Camille");
  await db.query(
    "insert into public.business_hours (business_id, weekday, starts_at, ends_at) values ($1, 4, '09:00', '20:00')",
    [pro.businessId],
  );
  const { rows: fixtures } = await db.query<{
    slug: string;
    service_id: string;
    date: string;
  }>(
    `select b.slug, s.id service_id, (d.today + (11 - extract(dow from d.today)::int) % 7 + 7 + week * 7)::text date
       from public.businesses b
       join public.services s on s.business_id = b.id
       cross join lateral (select (now() at time zone b.timezone)::date today) d
       cross join generate_series(0, 2) week
       where b.id = $1 order by week`,
    [pro.businessId],
  );
  const fixture = fixtures[0]!;
  const [first, second, ordinary] = fixtures.map(({ date }) => date) as [
    string,
    string,
    string,
  ];
  const { page, errors } = await signedInPage(pro.browser, {
    appearance: null,
    width: 390,
    height: 844,
    phone: true,
  });
  const url = `${APP}/app/settings/hours`;
  await page.goto(url);
  const chooseDate = async (date: string) => {
    await page.getByRole("switch", { name: "Jeudi ouvert" }).waitFor();
    await page.getByLabel("Date à modifier").fill(date);
  };
  const opening = page.getByLabel("Ouverture", { exact: true });
  const closing = page.getByLabel("Fermeture", { exact: true });
  for (const [date, end] of [
    [first, "18:00"],
    [second, "22:00"],
  ] as const) {
    await chooseDate(date);
    await opening.selectOption("09:00");
    await closing.selectOption(end);
    await page.getByRole("button", { name: "Enregistrer cette date" }).click();
    await page.getByText("Horaires enregistrés pour cette date.").waitFor();
    await page.getByRole("button", { name: "Choisir une autre date" }).click();
  }
  expect(await noSideScroll(page)).toBe(true);

  const lastSlotEnd = async (date: string) => {
    const response = await fetch(
      `${APP}/api/public/businesses/${fixture.slug}/availability?` +
        new URLSearchParams({ serviceId: fixture.service_id, date }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { slots: { localEndsAt: string }[] };
    };
    return payload.data.slots.at(-1)?.localEndsAt;
  };
  expect(await Promise.all([first, second, ordinary].map(lastSlotEnd))).toEqual(
    [`${first}T18:00`, `${second}T22:00`, `${ordinary}T20:00`],
  );

  await page.reload();
  await page.getByText("Prochaines dates personnalisées (2)").click();
  await page.getByRole("button", { name: /jeudi.*09:00 – 18:00/ }).click();
  expect(await page.getByLabel("Date à modifier").inputValue()).toBe(first);
  await page
    .getByRole("button", { name: "Rétablir les horaires habituels" })
    .waitFor();
  expect(await closing.inputValue()).toBe("18:00");
  await page
    .getByRole("button", { name: "Rétablir les horaires habituels" })
    .click();
  await page.getByText("Horaires habituels rétablis.").waitFor();
  expect(await lastSlotEnd(first)).toBe(`${first}T20:00`);
  expect(await lastSlotEnd(second)).toBe(`${second}T22:00`);
  expect(errors).toEqual([]);
});
