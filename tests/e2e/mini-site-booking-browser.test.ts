import { describe, expect, it } from "vitest";

import { sampleSite } from "@/features/experience/fixtures/sample-sites";
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
import { behindIngress } from "./support/ingress";
import { APP, Browser, db, professionalWithVisit } from "./support/studio";

// The whole journey through her published mini-site, against PostgreSQL:
// a service with a required and an optional group of options, her site
// published (save_site_draft, publish_site), a client who books from the
// site itself — her answers, the server's quote, the booking confirmed —
// then the appointment in the professional's agenda with the totals. The
// site's booking is the public booking (#42), never a second engine.

const VARIANTS = [
  {
    name: "phone 390, Mila",
    width: 390,
    phone: true,
    reduced: false,
    universe: "mila" as const,
    address: "203.0.113.31",
  },
  {
    name: "phone 320, Alma, less motion",
    width: 320,
    phone: true,
    reduced: true,
    universe: "alma" as const,
    address: "203.0.113.32",
  },
  {
    name: "computer, Nail Lab",
    width: 1280,
    phone: false,
    reduced: false,
    universe: "nail-lab" as const,
    address: "203.0.113.33",
  },
];

async function publishedSiteWithOptions(
  universe: "mila" | "alma" | "nail-lab",
  bookingFormat?: "calendar" | "chronological" | "guided",
) {
  const pro = await professionalWithVisit("Nour", "Lou");
  const actor = pro.browser.member!.userId;
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
  // Her options, written as her, through the catalogue's own function.
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

  // Her site, saved then published as her studio does.
  const config = sampleSite(universe);
  const saved = await db.query<{ revision: number }>(
    "select public.save_site_draft($1, $2, 0, 1, $3::jsonb) as revision",
    [
      pro.businessId,
      actor,
      JSON.stringify({
        ...config,
        ...(bookingFormat ? { bookingFormat } : {}),
        brand: { ...config.brand, name: "Studio Lumière" },
      }),
    ],
  );
  await db.query("select * from public.publish_site($1, $2, $3)", [
    pro.businessId,
    actor,
    saved.rows[0]!.revision,
  ]);
  return { ...pro, slug, service };
}

describe.each(VARIANTS)(
  "booking from her mini-site — $name",
  ({ name, width, phone, reduced, universe, address }) => {
    it("her site, her answers, the server's quote, confirmed, in her agenda", async () => {
      const pro = await publishedSiteWithOptions(universe);
      const { page, errors } = await signedInPage(new Browser(), {
        appearance: null,
        width,
        height: 860,
        phone,
      });
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      const check = async (what: string) => {
        expect(await noSideScroll(page), what).toBe(true);
        await expectAccessible(page, what);
        await capture(page, `mini-site booking ${name} ${what}`);
      };

      // A client of her published site, behind the trusted ingress.
      await behindIngress(page.context(), address);
      await page.goto(`${APP}/b/${pro.slug}`);
      await page.getByText("Studio Lumière").first().waitFor();
      // Her site says what her booking page says: "dès", the least of her
      // required answers (a required group can only add to it).
      // (Read in the page as rendered: a scene further down may not have
      // revealed itself yet.)
      expect(await page.locator("body").textContent()).toMatch(/dès 60/);

      await page
        .locator("[data-header-action]")
        .getByRole("button", { name: "Réserver" })
        .click();
      const sheet = page.getByRole("dialog", {
        name: "Réserver chez Studio Lumière",
      });
      await sheet
        .getByRole("heading", { name: "Choisissez une prestation" })
        .waitFor();
      await sheet.getByRole("button", { name: /Rehaussement de cils/ }).click();
      await sheet
        .getByRole("heading", { name: "Personnalisez votre prestation" })
        .waitFor();
      // Required: on its first answer. Optional: on none. The server's quote.
      expect(
        await sheet.getByRole("radio", { name: /Naturelle/ }).isChecked(),
      ).toBe(true);
      await sheet.getByText(/^1 h 15 · 60,00\s€$/).waitFor();
      await sheet.getByRole("radio", { name: /Volume/ }).check();
      await sheet.getByText(/^1 h 45 · 75,00\s€$/).waitFor();
      await sheet.getByRole("radio", { name: /^Oui/ }).check();
      await sheet.getByText(/^2 h · 85,00\s€$/).waitFor();
      await check("options");

      await sheet.getByRole("button", { name: "Choisir un créneau" }).click();
      await sheet
        .getByRole("heading", { name: "Choisissez un créneau" })
        .waitFor();
      const tomorrow = addDays(businessToday("Europe/Paris"), 1);
      await sheet
        .getByRole("button", { name: new RegExp(`, ${dayLabel(tomorrow)}$`) })
        .click();
      const slots = sheet.getByRole("list", {
        name: `Créneaux du ${dayLabel(tomorrow)}`,
      });
      await slots.waitFor();
      await slots.getByRole("button").first().click();

      await sheet.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
      await sheet.getByLabel(/^Prénom/).fill("Inès");
      await sheet
        .getByLabel(/^Email/)
        .fill(`ines-${pro.slug}@client.test.local`);
      await sheet.getByRole("button", { name: "Continuer" }).click();
      await sheet
        .getByRole("heading", { name: "Vérifiez et confirmez" })
        .waitFor();
      await sheet.getByText("Volume", { exact: true }).waitFor();
      await sheet.getByText(/^85,00\s€$/).waitFor();
      await check("review");

      // The server's answer to the booking itself, read on the wire.
      const answered = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/bookings" &&
          response.request().method() === "POST",
      );
      await sheet
        .getByRole("button", { name: /Confirmer la réservation/ })
        .click();
      const response = await answered;
      const body = (await response.json()) as {
        data?: {
          booking: {
            appointmentId: string;
            status: string;
            priceCents: number;
            durationMinutes: number;
            options: { label: string }[];
          };
        };
        error?: { code: string };
      };
      if (response.status() !== 201 || !body.data) {
        await capture(page, `mini-site booking ${name} refused`);
        throw new Error(
          `Not booked: HTTP ${response.status()} ${JSON.stringify(body.error ?? body)}`,
        );
      }
      expect(body.data.booking).toMatchObject({
        status: "confirmed",
        priceCents: 8500,
        durationMinutes: 120,
      });
      expect(body.data.booking.options.map((option) => option.label)).toEqual([
        "Volume",
        "Oui",
      ]);
      // Then what she sees, in her site's sheet: the confirmation.
      await sheet
        .getByRole("heading", { name: "Rendez-vous confirmé" })
        .waitFor();
      await sheet.getByText(/^85,00\s€$/).waitFor();
      await check("confirmed");

      // Booked as the server priced it, with her answers kept.
      const booked = await db.query<{
        id: string;
        status: string;
        price: number;
        duration: number;
        minutes: number;
        labels: string[];
        local: string;
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
      await capture(agenda.page, `mini-site booking ${name} agenda`);

      expect(errors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(agenda.errors).toEqual([]);
    });
  },
);

describe("her booking taken back (points 67, 70)", () => {
  it("says the slot is not booked yet, then resumes at the review after a reload", async () => {
    const pro = await publishedSiteWithOptions("mila");
    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 390,
      height: 860,
      phone: true,
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await behindIngress(page.context(), "203.0.113.34");
    const open = async () => {
      await page
        .locator("[data-header-action]")
        .getByRole("button", { name: "Réserver" })
        .click();
      return page.getByRole("dialog", { name: "Réserver chez Studio Lumière" });
    };

    await page.goto(`${APP}/b/${pro.slug}`);
    await page.getByText("Studio Lumière").first().waitFor();
    const sheet = await open();
    await sheet.getByRole("button", { name: /Rehaussement de cils/ }).click();
    await sheet
      .getByRole("heading", { name: "Personnalisez votre prestation" })
      .waitFor();
    await sheet.getByRole("button", { name: "Choisir un créneau" }).click();
    await sheet
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();
    const tomorrow = addDays(businessToday("Europe/Paris"), 1);
    await sheet
      .getByRole("button", { name: new RegExp(`, ${dayLabel(tomorrow)}$`) })
      .click();
    await sheet
      .getByRole("list", { name: `Créneaux du ${dayLabel(tomorrow)}` })
      .getByRole("button")
      .first()
      .click();

    await sheet.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
    await sheet.getByText("Créneau choisi, pas encore réservé.").waitFor();
    expect(await sheet.getByLabel(/^Téléphone/).isVisible()).toBe(false);
    await sheet.getByLabel(/^Prénom/).fill("Inès");
    await sheet.getByLabel(/^Email/).fill(`ines-${pro.slug}@client.test.local`);
    await sheet.getByRole("button", { name: "Continuer" }).click();
    await sheet
      .getByRole("heading", { name: "Vérifiez et confirmez" })
      .waitFor();
    // Her service has options: service, options, slot, details, review.
    await sheet.getByText("Étape 5 sur 5 · Dernière étape").waitFor();
    await sheet
      .getByText(/Ce créneau n’est pas encore réservé/)
      .first()
      .waitFor();

    // Back to her site after a reload: the booking resumes, nothing is sent.
    await page.reload();
    await page.getByText("Studio Lumière").first().waitFor();
    const resumed = await open();
    await resumed
      .getByRole("heading", { name: "Vérifiez et confirmez" })
      .waitFor();
    await resumed.getByText(/reprend là où/).waitFor();
    await resumed.getByText("Inès").first().waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "resumed review");
    await capture(page, "p67-resumed-390");

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  // Her notice sits on a fill her soft colour was not measured against:
  // in her own booking (themed), it must still read (axe found 4.35 and
  // 3.64 here before the fix).
  it("the notice reads well in her universe's own booking (alma, calendar, 320 px)", async () => {
    const pro = await publishedSiteWithOptions("alma", "calendar");
    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 320,
      height: 700,
      phone: true,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const open = async () => {
      await page
        .locator("[data-header-action]")
        .getByRole("button", { name: "Réserver" })
        .click();
      return page.getByRole("dialog", { name: "Réserver chez Studio Lumière" });
    };
    await page.goto(`${APP}/b/${pro.slug}`);
    await page.getByText("Studio Lumière").first().waitFor();
    // Her only service opens by itself in the calendar format.
    const sheet = await open();
    await sheet
      .getByRole("heading", { name: "Personnalisez votre prestation" })
      .waitFor();

    await page.reload();
    await page.getByText("Studio Lumière").first().waitFor();
    const resumed = await open();
    await resumed
      .getByRole("heading", { name: "Personnalisez votre prestation" })
      .waitFor();
    await resumed.getByText(/reprend là où/).waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "alma resumed notice");
    await capture(page, "p67-resumed-alma-320");
    expect(errors).toEqual([]);
  });
});
