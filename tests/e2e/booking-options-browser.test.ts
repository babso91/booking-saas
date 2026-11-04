import { describe, expect, it } from "vitest";

import {
  addDays,
  businessToday,
  dayLabel,
} from "@/features/public-booking/client/business-time";

import { capture } from "./support/capture";
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
  { name: "phone 390", width: 390, phone: true },
  { name: "phone 320", width: 320, phone: true },
  { name: "computer", width: 1280, phone: false },
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
  ({ name, width, phone }) => {
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
        .getByRole("button", { name: dayLabel(tomorrow), exact: true })
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

      await page
        .getByRole("button", { name: /Confirmer la réservation/ })
        .click();
      await page
        .getByRole("heading", { name: "Rendez-vous confirmé" })
        .waitFor();
      await page.getByText("Volume", { exact: true }).waitFor();
      await check("confirmed");

      // Booked as the server priced it, with her answers kept.
      const booked = await db.query<{
        id: string;
        price: number;
        duration: number;
        minutes: number;
        labels: string[];
        local: string;
      }>(
        `select a.id,
              a.price_cents_snapshot as price,
              a.duration_minutes_snapshot as duration,
              extract(epoch from a.ends_at - a.starts_at)::int / 60 as minutes,
              array(select o->>'label' from jsonb_array_elements(a.options_snapshot) o) as labels,
              to_char(a.starts_at at time zone 'Europe/Paris', 'YYYY-MM-DD') as local
         from public.appointments a
        where a.business_id = $1 and a.service_id = $2 and a.status = 'confirmed'
          and a.price_cents_snapshot = 8500`,
        [pro.businessId, pro.service],
      );
      expect(booked.rows).toEqual([
        {
          id: expect.any(String),
          price: 8500,
          duration: 120,
          minutes: 120,
          labels: ["Volume", "Oui"],
          local: tomorrow,
        },
      ]);

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
