import { describe, expect, it } from "vitest";

import {
  addDays,
  businessToday,
  dayLabel,
} from "@/features/public-booking/client/business-time";

import { capture } from "./support/capture";
import { behindIngress } from "./support/ingress";
import {
  expectAccessible,
  look,
  noSideScroll,
  signedInPage,
} from "./support/ecrin";
import { APP, Browser, db, professionalWithVisit } from "./support/studio";

// A client books online a service with a required and an optional group of
// options, on the real public page, against PostgreSQL: the price and
// duration she sees are the server's, the booking keeps her answers, and
// the appointment is in the professional's agenda with the totals. Nothing
// is computed or decided in the browser.

const VARIANTS = [
  { name: "phone 390", width: 390, phone: true, address: "203.0.113.21" },
  { name: "phone 320", width: 320, phone: true, address: "203.0.113.22" },
  { name: "computer", width: 1280, phone: false, address: "203.0.113.23" },
];

async function businessWithOptions() {
  const pro = await professionalWithVisit("Nour", "Lou");
  const { rows } = await db.query<{ slug: string; service: string }>(
    `select b.slug, s.id as service
       from public.businesses b
       join public.services s on s.business_id = b.id
      where b.id = $1`,
    [pro.businessId],
  );
  const { slug, service } = rows[0]!;
  // Open every day, 08:00–20:00: tomorrow always has slots.
  await db.query("delete from public.business_hours where business_id = $1", [
    pro.businessId,
  ]);
  for (let weekday = 0; weekday < 7; weekday += 1)
    await db.query(
      `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
       values ($1, $2, '08:00', '20:00')`,
      [pro.businessId, weekday],
    );
  const version = await db.query<{ version: number }>(
    "select version from public.services where id = $1",
    [service],
  );
  // Written as the professional, through the catalogue's own function.
  const { error } = await pro.browser.supabase().rpc("set_service_options", {
    p_business_id: pro.businessId,
    p_service_id: service,
    p_expected_version: version.rows[0]!.version,
    p_options: [
      {
        id: null,
        question: "Longueur",
        required: true,
        choices: [
          {
            id: null,
            label: "Naturelle",
            priceDeltaCents: 0,
            durationDeltaMinutes: 0,
          },
          {
            id: null,
            label: "Volume",
            priceDeltaCents: 1500,
            durationDeltaMinutes: 30,
          },
        ],
      },
      {
        id: null,
        question: "Dépose de l’ancienne pose ?",
        required: false,
        choices: [
          {
            id: null,
            label: "Oui",
            priceDeltaCents: 1000,
            durationDeltaMinutes: 15,
          },
        ],
      },
    ],
    p_deleted_option_ids: [],
    p_deleted_choice_ids: [],
  });
  expect(error).toBeNull();
  return { ...pro, slug, service };
}

describe.each(VARIANTS)(
  "online booking with options — $name",
  ({ name, width, phone, address }) => {
    it("her answers, the server's quote, the booking, then the agenda", async () => {
      const pro = await businessWithOptions();
      const { page, errors } = await signedInPage(new Browser(), {
        appearance: null,
        width,
        height: 860,
        phone,
      });
      const check = async (what: string) => {
        expect(await noSideScroll(page), what).toBe(true);
        await expectAccessible(page, what);
        await capture(page, `booking options ${name} ${what}`);
      };

      // A customer of the real page, behind the trusted ingress.
      await behindIngress(page.context(), address);
      await page.goto(`${APP}/b/${pro.slug}`);
      await page.getByRole("button", { name: /Rehaussement de cils/ }).click();
      await page
        .getByRole("heading", { name: "Personnalisez votre prestation" })
        .waitFor();
      // Required: on its first answer. Optional: on none. The server's quote.
      expect(
        await page.getByRole("radio", { name: /Naturelle/ }).isChecked(),
      ).toBe(true);
      expect(await page.getByRole("radio", { name: /^Sans/ }).isChecked()).toBe(
        true,
      );
      await page.getByText(/^1 h 15 · 60,00\s€$/).waitFor();
      await check("options");

      await page.getByRole("radio", { name: /Volume/ }).check();
      await page.getByText(/^1 h 45 · 75,00\s€$/).waitFor();
      await page.getByRole("radio", { name: /^Oui/ }).check();
      await page.getByText(/^2 h · 85,00\s€$/).waitFor();
      await check("options chosen");

      await page.getByRole("button", { name: "Choisir un créneau" }).click();
      await page
        .getByRole("heading", { name: "Choisissez un créneau" })
        .waitFor();
      const tomorrow = addDays(businessToday("Europe/Paris"), 1);
      await page
        .getByRole("button", { name: new RegExp(`, ${dayLabel(tomorrow)}$`) })
        .click();
      const slots = page.getByRole("list", {
        name: `Créneaux du ${dayLabel(tomorrow)}`,
      });
      await slots.waitFor();
      await check("slots");
      await slots.getByRole("button").first().click();

      await page.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
      await page.getByLabel(/^Prénom/).fill("Inès");
      await page
        .getByLabel(/^Email/)
        .fill(`ines-${pro.slug}@client.test.local`);
      await page.getByRole("button", { name: "Continuer" }).click();
      await page
        .getByRole("heading", { name: "Vérifiez et confirmez" })
        .waitFor();
      await page.getByText("Volume", { exact: true }).waitFor();
      await page.getByText(/^85,00\s€$/).waitFor();
      await check("review");

      // The terminal state is the server's answer to the booking itself,
      // read on the wire: a refusal fails here, with its code and body. (A
      // role="alert" cannot serve: Next's route announcer is one, on every
      // page, from the start.)
      const answered = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/bookings" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: /Confirmer la réservation/ })
        .click();
      const response = await answered;
      const body = (await response.json()) as {
        data?: {
          booking: {
            appointmentId: string;
            status: string;
            replayed: boolean;
            priceCents: number;
            durationMinutes: number;
            options: { label: string }[];
          };
        };
        error?: { code: string };
      };
      if (response.status() !== 201 || !body.data) {
        await capture(page, `booking options ${name} refused`);
        throw new Error(
          `Not booked: HTTP ${response.status()} ${JSON.stringify(body.error ?? body)}`,
        );
      }
      expect(body.data.booking).toMatchObject({
        status: "confirmed",
        replayed: false,
        priceCents: 8500,
        durationMinutes: 120,
      });
      expect(body.data.booking.options.map((option) => option.label)).toEqual([
        "Volume",
        "Oui",
      ]);
      // Then what she sees: the confirmation, from that answer.
      const main = page.getByRole("main");
      await main
        .getByRole("heading", { name: "Rendez-vous confirmé" })
        .waitFor();
      await main.getByText("Volume", { exact: true }).waitFor();
      await main.getByText(/^85,00\s€$/).waitFor();
      await check("confirmed");

      // Booked as the server priced it, with her answers kept.
      const booked = await db.query<{
        id: string;
        price: number;
        duration: number;
        minutes: number;
        labels: string[];
        local: string;
        status: string;
      }>(
        `select a.id,
              a.status,
              a.price_cents_snapshot as price,
              a.duration_minutes_snapshot as duration,
              extract(epoch from a.ends_at - a.starts_at)::int / 60 as minutes,
              array(select o->>'label' from jsonb_array_elements(a.options_snapshot) o) as labels,
              to_char(a.starts_at at time zone 'Europe/Paris', 'YYYY-MM-DD') as local
         from public.appointments a
        where a.id = $1 and a.business_id = $2 and a.service_id = $3`,
        [body.data.booking.appointmentId, pro.businessId, pro.service],
      );
      // The row the answer named, as the server priced it.
      expect(booked.rows).toEqual([
        {
          id: body.data.booking.appointmentId,
          status: "confirmed",
          price: 8500,
          duration: 120,
          minutes: 120,
          labels: ["Volume", "Oui"],
          local: tomorrow,
        },
      ]);

      // And only one: tomorrow holds this booking and nothing else.
      const tomorrowRows = await db.query(
        `select 1 from public.appointments
          where business_id = $1
            and to_char(starts_at at time zone 'Europe/Paris', 'YYYY-MM-DD') = $2`,
        [pro.businessId, tomorrow],
      );
      expect(tomorrowRows.rowCount).toBe(1);

      // In her agenda, with its totals.
      const agenda = await signedInPage(pro.browser, {
        appearance: look("classique"),
        width,
        height: 860,
        phone,
      });
      await agenda.page.goto(
        `${APP}/app?date=${tomorrow}&rdv=${booked.rows[0]!.id}`,
      );
      const details = agenda.page.getByRole("dialog");
      await details.getByText(/Inès/).first().waitFor();
      await details
        .getByText(/85,00\s€/)
        .first()
        .waitFor();
      await details.getByText(/2 h/).first().waitFor();
      await capture(agenda.page, `booking options ${name} agenda`);

      expect(errors).toEqual([]);
      expect(agenda.errors).toEqual([]);
    });
  },
);

// Codex's audit of #42: a service WITHOUT options also sends the price and
// duration she accepted, so a price raised between her review and her
// confirmation is refused by the server (quote_changed), nothing booked,
// and she is asked to agree to the new one.
describe("a price raised before she confirms — service without options", () => {
  it("nothing booked at the old price; the new one shown, then booked once she confirms again", async () => {
    const pro = await professionalWithVisit("Nora", "Lou");
    const { rows } = await db.query<{ slug: string; service: string }>(
      `select b.slug, s.id as service
         from public.businesses b
         join public.services s on s.business_id = b.id
        where b.id = $1`,
      [pro.businessId],
    );
    const { slug, service } = rows[0]!;
    await db.query("delete from public.business_hours where business_id = $1", [
      pro.businessId,
    ]);
    for (let weekday = 0; weekday < 7; weekday += 1)
      await db.query(
        `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
         values ($1, $2, '08:00', '20:00')`,
        [pro.businessId, weekday],
      );
    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 390,
      height: 860,
      phone: true,
    });
    await behindIngress(page.context(), "203.0.113.24");
    await page.goto(`${APP}/b/${slug}`);
    await page.getByRole("button", { name: /Rehaussement de cils/ }).click();
    await page
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();
    const tomorrow = addDays(businessToday("Europe/Paris"), 1);
    await page
      .getByRole("button", { name: new RegExp(`, ${dayLabel(tomorrow)}$`) })
      .click();
    await page
      .getByRole("list", { name: `Créneaux du ${dayLabel(tomorrow)}` })
      .getByRole("button")
      .first()
      .click();
    await page.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
    await page.getByLabel(/^Prénom/).fill("Inès");
    await page.getByLabel(/^Email/).fill(`ines-${slug}@client.test.local`);
    await page.getByRole("button", { name: "Continuer" }).click();
    await page
      .getByRole("heading", { name: "Vérifiez et confirmez" })
      .waitFor();
    await page.getByText(/^60,00\s€$/).waitFor();

    // The professional raises the price while the review is on screen.
    await db.query(
      "update public.services set price_cents = 7000 where id = $1",
      [service],
    );

    const post = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/bookings" &&
          response.request().method() === "POST",
      );
    const first = post();
    await page
      .getByRole("button", { name: /Confirmer la réservation/ })
      .click();
    const refused = await first;
    expect(refused.request().postDataJSON()).toMatchObject({
      expectedPriceCents: 6000,
      expectedDurationMinutes: 75,
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "quote_changed" },
    });
    // Nothing booked tomorrow (her visit going on now is today).
    const none = await db.query(
      `select 1 from public.appointments
        where business_id = $1
          and to_char(starts_at at time zone 'Europe/Paris', 'YYYY-MM-DD') = $2`,
      [pro.businessId, tomorrow],
    );
    expect(none.rowCount).toBe(0);

    // Asked again, with the new price, on the same slot.
    await page.getByText("Le prix ou la durée a changé").waitFor();
    await page.getByText(/^70,00\s€$/).waitFor();
    await capture(page, "booking price raised before confirming");

    const second = post();
    await page
      .getByRole("button", { name: /Confirmer la réservation/ })
      .click();
    const booked = await second;
    expect(booked.request().postDataJSON()).toMatchObject({
      expectedPriceCents: 7000,
    });
    expect(booked.status()).toBe(201);
    const rowsBooked = await db.query<{ price: number }>(
      `select price_cents_snapshot as price from public.appointments
        where business_id = $1 and service_id = $2
          and to_char(starts_at at time zone 'Europe/Paris', 'YYYY-MM-DD') = $3`,
      [pro.businessId, service, tomorrow],
    );
    expect(rowsBooked.rows).toEqual([{ price: 7000 }]);
    expect(errors).toEqual([]);
  });
});
