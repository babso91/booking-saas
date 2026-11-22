import { describe, expect, it } from "vitest";

import type { Practical } from "@/features/experience/engine/config";
import { sampleSite } from "@/features/experience/fixtures/sample-sites";
import { emptyPractical } from "@/features/experience/practical";
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
  practical?: Partial<Practical>,
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
        ...(practical
          ? { practical: { ...emptyPractical, ...practical } }
          : {}),
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
      // Point 55: her answer is followed by what it adds.
      await sheet.getByText(/^Volume \(\+15,00\s€ · \+30 min\)$/).waitFor();
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

describe("her catalogue read clearly (points 33, 35, 55, 56)", () => {
  it("categories, a long description folded, options costed, place and conditions, at 390", async () => {
    const address = "12 rue Mercière, 69002 Lyon";
    const policy = "Annulation gratuite jusqu’à 24 h avant le rendez-vous.";
    const pro = await publishedSiteWithOptions("mila", undefined, {
      address,
      lateness:
        "Au-delà de 15 minutes de retard, la prestation est raccourcie.",
    });
    await db.query(
      "update public.businesses set cancellation_policy = $2 where id = $1",
      [pro.businessId, policy],
    );
    const categories: Record<string, string> = {};
    for (const name of ["Cils", "Sourcils"]) {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.service_categories (business_id, name)
         values ($1, $2) returning id`,
        [pro.businessId, name],
      );
      categories[name] = rows[0]!.id;
    }
    // With the seed's uncategorised "Rehaussement de cils" (options): seven.
    const longDescription = [
      "Une pose pensée pour votre regard, réalisée cil à cil avec des fibres légères.",
      "",
      "Comptez un temps d’échange avant la pose pour choisir la courbe et la longueur.",
      "Évitez l’eau chaude et le maquillage des yeux dans les 24 heures qui suivent.",
      "Un rappel est conseillé après trois semaines.",
    ].join("\n");
    for (const [order, name, description, category] of [
      [1, "Volume russe", longDescription, "Cils"],
      [2, "Volume mixte", "Entre naturel et dense.", "Cils"],
      [3, "Brow lift", "Tenue 6 à 8 semaines.", "Sourcils"],
      [4, "Teinture des sourcils", null, "Sourcils"],
      [5, "Soin hydratant", null, null],
      [6, "Soin anti-âge", null, null],
    ] as const) {
      await db.query(
        `insert into public.services
           (business_id, name, description, duration_minutes, price_cents,
            display_order, category_id)
         values ($1, $2, $3, 60, 5000, $4, $5)`,
        [
          pro.businessId,
          name,
          description,
          order,
          category ? categories[category]! : null,
        ],
      );
    }

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
    await behindIngress(page.context(), "203.0.113.35");
    await page.goto(`${APP}/b/${pro.slug}`);
    await page.getByText("Studio Lumière").first().waitFor();

    // Point 33, on her site: shortcuts, and the group without a category.
    const scene = page.locator("[data-booking-scene]");
    await scene.getByText("Soin anti-âge").waitFor();
    const nav = page.getByRole("navigation", { name: "Catégories" });
    await nav.waitFor();
    expect(
      await nav
        .getByRole("link")
        .allTextContents()
        .then((names) => names.map((name) => name.trim())),
    ).toEqual(["Cils", "Sourcils", "Autres prestations"]);
    await page
      .getByRole("heading", { name: "Autres prestations" })
      .first()
      .waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "p33 site categories");
    await capture(page, "p33-categories-390");

    // The booking: sticky shortcuts that bring her to a category's heading.
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
    const jump = sheet.getByRole("navigation", { name: "Catégories" });
    await jump.waitFor();
    await jump.getByRole("button", { name: "Sourcils" }).click();
    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent,
    }));
    expect(focused).toEqual({ tag: "H3", text: "Sourcils" });

    // Point 35: the long description folded, her line breaks kept.
    const more = sheet.getByRole("button", { name: "Lire la suite" });
    await more.waitFor();
    expect(await more.count()).toBe(1);
    await more.click();
    await sheet.getByRole("button", { name: "Réduire" }).waitFor();
    expect(
      await sheet
        .getByText(/Évitez l’eau chaude/)
        .evaluate((element) => getComputedStyle(element).whiteSpace),
    ).toMatch(/pre/);

    // Point 55: the service with its options, each cost said, the total.
    await sheet.getByRole("button", { name: /Rehaussement de cils/ }).click();
    await sheet
      .getByRole("heading", { name: "Personnalisez votre prestation" })
      .waitFor();
    await sheet.getByRole("radio", { name: /Volume/ }).check();
    const box = sheet.locator("dl").filter({ hasText: "Total" });
    await box.getByText("Total", { exact: true }).waitFor();
    await box.getByText("Longueur : Volume").waitFor();
    await box.getByText(/\+15,00\s€ · \+30 min/).waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await capture(page, "p55-options-390");

    // Point 56: where, and her conditions, before her details.
    await sheet.getByRole("button", { name: "Choisir un créneau" }).click();
    await sheet
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();
    await sheet.getByText("Lieu :").waitFor();
    await sheet.getByText(address).waitFor();
    await sheet
      .getByRole("button", { name: /^Conditions : annulation, retard/ })
      .click();
    await sheet.getByText(policy).waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "p56 slot step conditions");
    await capture(page, "p56-conditions-390");

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
