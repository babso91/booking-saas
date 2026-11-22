import { expect, it } from "vitest";

import { addDaysToLocalDate } from "@/lib/time/local-date";

import { hydrated, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// Point 101 in a real browser, on a phone: she closes a booked day, cancels
// one appointment, moves the other, writes a word, confirms once.
it("closes a booked day: one cancelled, one moved, her customers told in her words", async () => {
  const pro = await professionalWithVisit("Nina", "Inès");
  const {
    rows: [fixture],
  } = await db.query<{ day: string; service_id: string; client_id: string }>(
    `select ((now() at time zone b.timezone)::date + 10)::text as day,
            s.id service_id, c.id client_id
     from public.businesses b
     join public.services s on s.business_id = b.id
     join public.clients c on c.business_id = b.id
     where b.id = $1`,
    [pro.businessId],
  );
  const day = fixture!.day;
  const later = addDaysToLocalDate(day, 2);
  const {
    rows: [zoe],
  } = await db.query<{ id: string }>(
    "insert into public.clients (business_id, first_name, phone) values ($1, 'Zoé', '06 11 22 33 44') returning id",
    [pro.businessId],
  );
  const book = async (clientId: string, time: string) =>
    (
      await db.query<{ id: string }>(
        `insert into public.appointments (
           business_id, client_id, service_id, starts_at, ends_at, status,
           service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot,
           buffer_minutes_snapshot)
         select $1, $2, $3, t, t + interval '75 minutes', 'confirmed',
                'Rehaussement de cils', 75, 6000, 0
         from (select ($4::date + $5::time) at time zone 'Europe/Paris' as t) x
         returning id`,
        [pro.businessId, clientId, fixture!.service_id, day, time],
      )
    ).rows[0]!.id;
  const ines = await book(fixture!.client_id, "10:00");
  const zoeVisit = await book(zoe!.id, "14:00");

  const { page, errors } = await signedInPage(pro.browser, {
    appearance: null,
    width: 390,
    height: 844,
    phone: true,
  });
  await page.goto(`${APP}/app/settings/hours`);
  await (
    await hydrated(
      page.getByRole("button", { name: "Planifier une fermeture" }),
    )
  ).click();
  await page.getByLabel("Premier jour fermé").fill(day);
  await page.getByRole("button", { name: "Enregistrer la fermeture" }).click();

  const planner = page.getByRole("region", {
    name: "Rendez-vous sur ces dates",
  });
  await planner.getByRole("heading", { name: /^2 rendez-vous le / }).waitFor();
  expect(await planner.innerText()).toContain(
    "Pas d’e-mail : préviens-la toi-même au 06 11 22 33 44.",
  );
  // Inès: moved two days later, same time.
  await planner
    .getByRole("group", { name: /^Inès Visite/ })
    .locator("label", { hasText: "Reporter" })
    .click();
  await planner.getByLabel("Nouvelle date pour Inès Visite").fill(later);
  await planner
    .getByLabel(/Un mot pour tes clientes/)
    .fill("Fermeture imprévue, désolée !");
  expect(await planner.innerText()).toContain(
    "1 rendez-vous annulé, 1 rendez-vous reporté. 1 cliente sera prévenue par e-mail.",
  );
  expect(await noSideScroll(page)).toBe(true);
  await planner
    .getByRole("button", { name: "Fermer et prévenir mes clientes" })
    .click();
  await page
    .getByRole("dialog", { name: /^Fermer le / })
    .getByRole("button", { name: "Confirmer la fermeture" })
    .click();
  await page
    .getByText(
      "Fermeture enregistrée. Rendez-vous : 1 annulé, 1 reporté. 1 cliente prévenue par e-mail.",
    )
    .waitFor();

  const { rows } = await db.query<{
    id: string;
    status: string;
    local: string;
  }>(
    `select id, status, to_char(starts_at at time zone 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') as local
     from public.appointments where id = any($1)`,
    [[ines, zoeVisit]],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(ines)).toMatchObject({
    status: "confirmed",
    local: `${later}T10:00`,
  });
  expect(byId.get(zoeVisit)).toMatchObject({ status: "cancelled" });
  const { rows: notices } = await db.query<{ type: string; message: string }>(
    `select type, payload -> 'closure' ->> 'message' as message from public.email_events
     where appointment_id = any($1) and type <> 'appointment_reminder'`,
    [[ines, zoeVisit]],
  );
  expect(notices).toEqual([
    { type: "appointment_changed", message: "Fermeture imprévue, désolée !" },
  ]);
  await page
    .getByRole("list", { name: "Fermetures prévues" })
    .getByText(
      /décembre|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre/,
    )
    .first()
    .waitFor();
  expect(errors).toEqual([]);
  await page.context().close();
});
