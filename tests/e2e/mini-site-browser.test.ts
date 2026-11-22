import { describe, expect, it } from "vitest";

import { sampleSite } from "@/features/experience/fixtures/sample-sites";
import { fromLabel, nextLabel } from "@/features/experience/next-slot";
import { dayLabel } from "@/features/public-booking/client/business-time";

import { capture } from "./support/capture";
import { expectAccessible, noSideScroll, signedInPage } from "./support/ecrin";
import { APP, Browser, db, professionalWithVisit } from "./support/studio";

// Her published mini-site on the public page, against PostgreSQL: the
// version published (never the draft), her real catalogue, and the real
// booking opening from it. Written through the database functions of
// docs/SITE_PUBLISHING_CONTRACT.md (save_site_draft, publish_site), as her
// studio will.

const VARIANTS = [
  {
    name: "phone 390, Mila",
    width: 390,
    phone: true,
    reduced: false,
    universe: "mila" as const,
  },
  {
    name: "phone 320, Alma, less motion",
    width: 320,
    phone: true,
    reduced: true,
    universe: "alma" as const,
  },
  {
    name: "computer, Nail Lab",
    width: 1280,
    phone: false,
    reduced: false,
    universe: "nail-lab" as const,
  },
];

async function saveDraft(
  businessId: string,
  actor: string,
  revision: number,
  name: string,
  universe: "mila" | "alma" | "nail-lab",
) {
  const config = sampleSite(universe);
  const { rows } = await db.query<{ revision: number }>(
    "select public.save_site_draft($1, $2, $3, 1, $4::jsonb) as revision",
    [
      businessId,
      actor,
      revision,
      JSON.stringify({ ...config, brand: { ...config.brand, name } }),
    ],
  );
  return rows[0]!.revision;
}

describe.each(VARIANTS)(
  "her mini-site — $name",
  ({ name, width, phone, reduced, universe }) => {
    it("the published version, her catalogue, the real booking; never the draft", async () => {
      const pro = await professionalWithVisit("Mila", "Lou");
      const actor = pro.browser.member!.userId;
      const { rows } = await db.query<{ slug: string }>(
        "select slug from public.businesses where id = $1",
        [pro.businessId],
      );
      const slug = rows[0]!.slug;

      const revision = await saveDraft(
        pro.businessId,
        actor,
        0,
        "Studio Lumière",
        universe,
      );
      await db.query("select * from public.publish_site($1, $2, $3)", [
        pro.businessId,
        actor,
        revision,
      ]);
      // A newer draft, never published: her clients never see it.
      await saveDraft(
        pro.businessId,
        actor,
        revision,
        "Brouillon secret",
        universe,
      );

      const { page, errors } = await signedInPage(new Browser(), {
        appearance: null,
        width,
        height: 860,
        phone,
      });
      // Every console error counts: a hydration mismatch is one.
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${APP}/b/${slug}`);
      await page.getByText("Studio Lumière").first().waitFor();
      expect(await page.getByText("Brouillon secret").count()).toBe(0);
      // Her real service, from her catalogue (get_public_catalog).
      await page.getByText("Rehaussement de cils").first().waitFor();
      // No photo yet: drawn in her universe's colours, never a broken image.
      expect(await page.locator("img").count()).toBe(0);
      expect(await page.locator("[data-no-photo]").count()).toBeGreaterThan(0);
      expect(await noSideScroll(page)).toBe(true);
      await expectAccessible(page, "mini-site");
      await capture(page, `mini-site ${name}`);

      // The real booking, from her site.
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
      await sheet
        .getByRole("button", { name: /Rehaussement de cils/ })
        .waitFor();
      await capture(page, `mini-site ${name} booking`);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });

      expect(errors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  },
);

// Higani points 5 and 17: her practical infos, her usual hours read from
// her schedule, the index straight to them, and an empty gallery left out.
describe("her practical infos and the index", () => {
  it("phone 390: the index leads to her infos; her hours are her schedule's", async () => {
    const pro = await professionalWithVisit("Mila", "Lou");
    const actor = pro.browser.member!.userId;
    const { rows } = await db.query<{ slug: string }>(
      "select slug from public.businesses where id = $1",
      [pro.businessId],
    );
    const slug = rows[0]!.slug;
    await db.query("delete from public.business_hours where business_id = $1", [
      pro.businessId,
    ]);
    for (const [weekday, startsAt, endsAt] of [
      [1, "09:00", "12:30"],
      [1, "14:00", "19:00"],
      [6, "10:00", "17:00"],
    ] as const) {
      await db.query(
        `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
         values ($1, $2, $3, $4)`,
        [pro.businessId, weekday, startsAt, endsAt],
      );
    }
    const config = sampleSite("mila");
    expect(config.content.works).toEqual([]);
    const { rows: saved } = await db.query<{ revision: number }>(
      "select public.save_site_draft($1, $2, 0, 1, $3::jsonb) as revision",
      [
        pro.businessId,
        actor,
        JSON.stringify({
          ...config,
          brand: { ...config.brand, name: "Studio Lumière" },
          practical: {
            address: "12 rue Mercière, 69002 Lyon",
            area: "",
            access: "Code 4B12, 2e étage.",
            instructions: "Venir démaquillée.",
            payment: "CB, espèces",
            accessibility: "",
            phone: "04 78 00 00 00",
            email: "",
            showHours: true,
          },
        }),
      ],
    );
    await db.query("select * from public.publish_site($1, $2, $3)", [
      pro.businessId,
      actor,
      saved[0]!.revision,
    ]);

    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 390,
      height: 844,
      phone: true,
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${APP}/b/${slug}`);
    await page.getByText("Studio Lumière").first().waitFor();
    // No work published yet: no empty "Réalisations 00".
    expect(await page.getByText("Réalisations").count()).toBe(0);

    await page.getByRole("button", { name: "Sommaire" }).click();
    const index = page.getByRole("dialog", { name: "Sommaire" });
    await index.getByRole("button", { name: "Infos pratiques" }).waitFor();
    expect(
      await index.getByRole("button", { name: "Réalisations" }).count(),
    ).toBe(0);
    await expectAccessible(page, "mini-site index");
    await capture(page, "mini-site index 390");
    await index.getByRole("button", { name: "Infos pratiques" }).click();
    await index.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.id === "infos");

    const infos = page.locator("#infos");
    await infos.getByText("Horaires habituels").first().waitFor();
    // Her schedule's ranges, a lunch break included; closed days said.
    const monday = infos.getByRole("row", { name: /Lundi/ });
    expect(await monday.textContent()).toContain("9 h – 12 h 30, 14 h – 19 h");
    expect(
      await infos.getByRole("row", { name: /Mardi/ }).textContent(),
    ).toContain("Fermé");
    await infos.getByText("Code 4B12, 2e étage.").waitFor();
    expect(
      await infos
        .getByRole("link", { name: "04 78 00 00 00" })
        .getAttribute("href"),
    ).toBe("tel:0478000000");
    expect(
      await infos
        .getByRole("link", { name: /Itinéraire/ })
        .getAttribute("target"),
    ).toBe("_blank");
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "mini-site practical");
    await capture(page, "mini-site practical 390");

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

// Higani points 36 and 37: a long catalogue (eight services and more) on her
// published site. Two close services read together, a search by name or
// category on her site and in the booking it opens.
describe("her long catalogue", () => {
  it("phone 320: two close services open together; found by name or category", async () => {
    const pro = await professionalWithVisit("Mila", "Lou");
    const actor = pro.browser.member!.userId;
    const { rows } = await db.query<{ slug: string }>(
      "select slug from public.businesses where id = $1",
      [pro.businessId],
    );
    const slug = rows[0]!.slug;
    const { rows: category } = await db.query<{ id: string }>(
      `insert into public.service_categories (business_id, name)
       values ($1, 'Sourcils') returning id`,
      [pro.businessId],
    );
    // With the seed's "Rehaussement de cils": nine services.
    for (const [index, name, description, inCategory] of [
      [1, "Volume russe", "Dense et léger, effet œil de biche.", false],
      [2, "Volume mixte", "Entre naturel et dense.", false],
      [3, "Teinture des cils", null, false],
      [4, "Restructuration", null, true],
      [5, "Brow lift", "Tenue 6 à 8 semaines.", true],
      [6, "Épilation", null, true],
      [7, "Soin hydratant", null, false],
      [8, "Soin anti-âge", null, false],
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
          index,
          inCategory ? category[0]!.id : null,
        ],
      );
    }
    const revision = await saveDraft(
      pro.businessId,
      actor,
      0,
      "Studio Lumière",
      "mila",
    );
    await db.query("select * from public.publish_site($1, $2, $3)", [
      pro.businessId,
      actor,
      revision,
    ]);

    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 320,
      height: 760,
      phone: true,
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${APP}/b/${slug}`);
    const scene = page.locator("[data-booking-scene]");
    await scene.getByText("Volume mixte").waitFor();

    // Point 36: opening the second does not close the first.
    const row = (name: string) =>
      scene.getByRole("button", { name: new RegExp(name) });
    await row("Volume russe").click();
    await row("Volume mixte").click();
    expect(await row("Volume russe").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(await row("Volume mixte").getAttribute("aria-expanded")).toBe(
      "true",
    );
    await scene.getByText("Dense et léger, effet œil de biche.").waitFor();
    await scene.getByText("Entre naturel et dense.").waitFor();

    // Point 37: by category, then by name; nothing found is said.
    const search = scene.getByRole("searchbox", {
      name: "Rechercher une prestation",
    });
    await search.fill("sourcils");
    await scene.getByText("3 prestations").waitFor();
    await scene.getByText("Brow lift").waitFor();
    expect(await scene.getByText("Volume russe").count()).toBe(0);
    await search.fill("rehauss");
    await scene.getByText("1 prestation").waitFor();
    await search.fill("brushing");
    await scene
      .getByText("Aucune prestation ne correspond à « brushing »")
      .waitFor();
    await scene.getByRole("button", { name: "Effacer la recherche" }).click();
    await scene.getByText("Soin anti-âge").waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await expectAccessible(page, "mini-site long catalogue");
    await capture(page, "mini-site long catalogue 320");

    // The booking it opens: searched too, the service found is booked.
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
    await sheet
      .getByRole("searchbox", { name: "Rechercher une prestation" })
      .fill("brow");
    await sheet.getByText("1 prestation").waitFor();
    await expectAccessible(page, "booking long catalogue");
    await sheet.getByRole("button", { name: /Brow lift/ }).click();
    await sheet
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

// Higani point 2: her next availability on her site, read from her real
// schedule by get_public_next_slots (Cloud, #127); the booking opens on
// that day.
describe("her next availability", () => {
  it("phone 390: said on her service and in the booking bar; the booking opens on that day", async () => {
    const pro = await professionalWithVisit("Mila", "Lou");
    const actor = pro.browser.member!.userId;
    const { rows } = await db.query<{ slug: string }>(
      "select slug from public.businesses where id = $1",
      [pro.businessId],
    );
    const slug = rows[0]!.slug;
    await db.query("delete from public.business_hours where business_id = $1", [
      pro.businessId,
    ]);
    for (const weekday of [1, 2, 3, 4, 5, 6]) {
      await db.query(
        `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
         values ($1, $2, '09:00', '19:00')`,
        [pro.businessId, weekday],
      );
    }
    const revision = await saveDraft(
      pro.businessId,
      actor,
      0,
      "Studio Lumière",
      "mila",
    );
    await db.query("select * from public.publish_site($1, $2, $3)", [
      pro.businessId,
      actor,
      revision,
    ]);
    // What her schedule really offers next, and her today (Europe/Paris).
    const { rows: next } = await db.query<{ local: string; today: string }>(
      `select local_starts_at as local,
              (now() at time zone 'Europe/Paris')::date::text as today
         from public.get_public_next_slots($1)
        where local_starts_at is not null
        order by starts_at
        limit 1`,
      [slug],
    );
    const { local, today } = next[0]!;

    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 390,
      height: 844,
      phone: true,
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${APP}/b/${slug}`);
    await page.getByText("Studio Lumière").first().waitFor();

    // Her booking bar: her next availability, whatever the service.
    await page.getByText(fromLabel(local, today)).waitFor();
    // Her service, once open: its own next slot.
    const scene = page.locator("[data-booking-scene]");
    await scene.getByRole("button", { name: /Rehaussement de cils/ }).click();
    await scene
      .getByText(`Prochaine dispo · ${nextLabel(local, today)}`)
      .waitFor();
    await expectAccessible(page, "mini-site next availability");
    await capture(page, "mini-site next availability 390");

    // Booked from there: the slots of that day are the ones read.
    const day = local.slice(0, 10);
    const read = page.waitForRequest(
      (request) =>
        request.url().includes("/availability") &&
        new URL(request.url()).searchParams.get("date") === day,
    );
    await scene.getByRole("button", { name: /Réserver ce soin/ }).click();
    await read;
    await page
      .getByRole("dialog", { name: "Réserver chez Studio Lumière" })
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

// Higani point 60: a day without a slot offers her next real one.
describe("her next opening (point 60)", () => {
  it("phone 390: an empty today says so and offers her next slot; the button opens that day", async () => {
    const pro = await professionalWithVisit("Mila", "Lou");
    const actor = pro.browser.member!.userId;
    const { rows } = await db.query<{ slug: string }>(
      "select slug from public.businesses where id = $1",
      [pro.businessId],
    );
    const slug = rows[0]!.slug;
    // One weekday only, three days after today (Europe/Paris): today is closed.
    const { rows: days } = await db.query<{
      today: string;
      open: string;
      weekday: number;
    }>(
      `select (now() at time zone 'Europe/Paris')::date::text as today,
              ((now() at time zone 'Europe/Paris')::date + 3)::text as open,
              extract(dow from (now() at time zone 'Europe/Paris')::date + 3)::int as weekday`,
    );
    const { today, open, weekday } = days[0]!;
    await db.query("delete from public.business_hours where business_id = $1", [
      pro.businessId,
    ]);
    await db.query(
      `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
       values ($1, $2, '09:00', '19:00')`,
      [pro.businessId, weekday],
    );
    const revision = await saveDraft(
      pro.businessId,
      actor,
      0,
      "Studio Lumière",
      "mila",
    );
    await db.query("select * from public.publish_site($1, $2, $3)", [
      pro.businessId,
      actor,
      revision,
    ]);

    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 390,
      height: 844,
      phone: true,
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${APP}/b/${slug}`);
    await page.getByText("Studio Lumière").first().waitFor();

    const scene = page.locator("[data-booking-scene]");
    await scene.getByRole("button", { name: /Rehaussement de cils/ }).click();
    await scene.getByRole("button", { name: /Réserver ce soin/ }).click();
    const dialog = page.getByRole("dialog", {
      name: "Réserver chez Studio Lumière",
    });
    await dialog
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();

    // The sheet opens on her next availability (point 2): go back to today.
    await dialog.getByRole("button", { name: dayLabel(today) }).click();

    await dialog.getByText("Aucun créneau disponible ce jour-là.").waitFor();
    const next = dialog.getByRole("button", {
      name: new RegExp(
        `^Prochain créneau : ${dayLabel(open)} à \\d{2}:\\d{2}$`,
      ),
    });
    await next.waitFor();
    expect(await next.innerText()).toBe(
      `Prochain créneau : ${dayLabel(open)} à 09:00`,
    );
    await expectAccessible(page, "booking next opening");
    expect(await noSideScroll(page)).toBe(true);
    await capture(page, "p60-next-opening-390");

    // Tapped: that day's slots are offered.
    await next.click();
    await dialog.getByText("Aucun créneau disponible ce jour-là.").waitFor({
      state: "detached",
    });
    await dialog
      .getByRole("button", { name: new RegExp(`${dayLabel(open)} à 09:00`) })
      .first()
      .waitFor();

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
