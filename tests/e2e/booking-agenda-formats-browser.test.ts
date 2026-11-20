import { expect, it } from "vitest";
import { sampleSite } from "@/features/experience/fixtures/sample-sites";
import {
  bookingFormats,
  type BookingFormat,
} from "@/features/public-booking/formats";
import {
  expectAccessible,
  hydrated,
  look,
  noSideScroll,
  signedInPage,
} from "./support/ecrin";
import { APP, db, professionalWithVisit, wear } from "./support/studio";

async function provider() {
  const pro = await professionalWithVisit("Nina", "Lou");
  const {
    rows: [business],
  } = await db.query<{ slug: string }>(
    "select slug from public.businesses where id = $1",
    [pro.businessId],
  );
  await db.query(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
      select $1, day, '09:00', '18:00' from generate_series(0,6) day`,
    [pro.businessId],
  );
  return { ...pro, slug: business!.slug };
}

it("publishes the chosen Core booking format, preserves it across universes and takes a visitor to a real slot", async () => {
  const pro = await provider();
  const { page, errors } = await signedInPage(pro.browser, {
    width: 390,
    phone: true,
    appearance: null,
  });
  try {
    await page.route("https://images.unsplash.com/**", (route) =>
      route.abort(),
    );
    await page.goto(APP + "/app/site");
    const saved = page
      .getByRole("status")
      .filter({ hasText: "Brouillon enregistré" });
    await saved.waitFor();
    const settings = page.getByRole("button", {
      name: "Réservation",
      exact: true,
    });
    await settings.click();
    const formats = page.getByRole("group", {
      name: "Parcours de réservation",
    });
    expect(await formats.getByRole("radio").count()).toBe(5);
    expect(
      await formats.getByRole("radio", { name: /^Classique/ }).isChecked(),
    ).toBe(true);
    await formats.getByRole("radio", { name: /^Chronologique/ }).check();
    await formats.getByRole("button", { name: "Essayer ce parcours" }).click();
    const preview = page.getByRole("dialog", { name: /Réserver chez/ });
    await preview
      .getByText("Aperçu du parcours · Réservation désactivée")
      .waitFor();
    await preview.getByRole("button", { name: "Semaine suivante" }).click();
    await preview
      .getByRole("button", { name: / à \d{2}:\d{2}$/ })
      .first()
      .waitFor();
    await preview.getByRole("button", { name: /Fermer/ }).click();
    await preview.waitFor({ state: "detached" });
    await saved.waitFor();
    await page.getByRole("button", { name: "Univers", exact: true }).click();
    await page.getByRole("button", { name: /Maison Alma/ }).click();
    await settings.click();
    expect(
      await formats.getByRole("radio", { name: /^Chronologique/ }).isChecked(),
    ).toBe(true);
    await saved.waitFor();
    await page.getByRole("button", { name: "Publier", exact: true }).click();
    await page.getByRole("button", { name: "Publié ✓" }).waitFor();
    await page.context().clearCookies();
    await page.goto(APP + "/b/" + pro.slug);
    await (
      await hydrated(
        page
          .locator("[data-header-action]")
          .getByRole("button", { name: "Réserver" }),
      )
    ).click();
    const dialog = page.getByRole("dialog");
    expect(
      await dialog
        .getByRole("button", { name: "Semaine", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const slots = dialog.getByRole("button", { name: / à \d{2}:\d{2}$/ });
    // Near the end of the week all remaining openings can be in the past.
    await dialog.getByRole("button", { name: "Semaine suivante" }).click();
    await slots.first().click();
    await dialog.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
    expect(await noSideScroll(page)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
});

it.each([
  { universe: "mila", width: 390, plan: "core" },
  { universe: "alma", width: 320, plan: "signature" },
  { universe: "nail-lab", width: 1280, plan: "signature" },
] as const)(
  "renders every public format in $universe at $width px",
  async ({ universe, width, plan }) => {
    const pro = await provider();
    const base = sampleSite(universe);
    const actor = pro.browser.member!.userId;
    await db.query("select public.set_site_plan($1, $2)", [
      pro.businessId,
      plan,
    ]);
    const { page, errors } = await signedInPage(pro.browser, {
      width,
      phone: width < 600,
      appearance: null,
    });
    try {
      await page.context().clearCookies();
      if (width === 320) await page.emulateMedia({ reducedMotion: "reduce" });
      let revision = 0;
      for (const format of bookingFormats) {
        const { rows } = await db.query<{ revision: number }>(
          "select public.save_site_draft($1, $2, $3, 1, $4::jsonb) as revision",
          [
            pro.businessId,
            actor,
            revision,
            JSON.stringify({ ...base, bookingFormat: format }),
          ],
        );
        revision = rows[0]!.revision;
        await db.query("select * from public.publish_site($1, $2, $3)", [
          pro.businessId,
          actor,
          revision,
        ]);
        await page.goto(APP + "/b/" + pro.slug);
        await (
          await hydrated(
            page
              .locator("[data-header-action]")
              .getByRole("button", { name: "Réserver" }),
          )
        ).click();
        const dialog = page.getByRole("dialog", {
          name: "Réserver chez " + base.brand.name,
        });
        await dialog.locator(`[data-booking-format="${format}"]`).waitFor();
        if (format === "showcase")
          await dialog.getByText(base.brand.intro, { exact: true }).waitFor();
        if (format === "guided")
          await dialog
            .getByRole("navigation", { name: "Étapes de la réservation" })
            .waitFor();
        if (
          format === "classic" ||
          format === "guided" ||
          format === "showcase"
        ) {
          await dialog
            .getByRole("button", { name: /Rehaussement de cils/ })
            .click();
        }
        const initialView: Record<BookingFormat, string> = {
          classic: "Jour",
          guided: "Jour",
          showcase: "Jour",
          calendar: "Mois",
          chronological: "Semaine",
        };
        const active = dialog.getByRole("button", {
          name: initialView[format],
          exact: true,
        });
        await active.waitFor();
        expect(await active.getAttribute("aria-pressed")).toBe("true");
        expect(await noSideScroll(page)).toBe(true);
        if (format === "calendar")
          await expectAccessible(page, universe + " booking calendar");
      }
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  },
  90_000,
);

it("remembers each Signature agenda across devices and universes and enforces the plan on a stale open page", async () => {
  const pro = await provider();
  const { page, errors } = await signedInPage(pro.browser, {
    width: 390,
    phone: true,
    appearance: look("ecrin", "glass"),
  });
  try {
    await page.goto(APP + "/app");
    const selector = page.getByRole("combobox", { name: "Format d’agenda" });
    expect(await selector.count()).toBe(0);
    await db.query("select public.set_site_plan($1, 'signature')", [
      pro.businessId,
    ]);
    await page.reload();
    await (await hydrated(selector)).selectOption("visual");
    await page.locator('[data-agenda-format="visual"]').waitFor();
    expect(
      await page
        .getByRole("button", { name: "Mois", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await page
      .getByRole("button", { name: /1 rendez-vous,/ })
      .first()
      .waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await selector.selectOption("availability");
    const available = page.getByLabel("Afficher les disponibilités");
    await available.selectOption({ label: "Rehaussement de cils" });
    await page.getByRole("button", { name: "Semaine suivante" }).click();
    await page
      .locator('[data-agenda-format="availability"]')
      .getByText("09:00", { exact: true })
      .first()
      .waitFor();
    expect(await available.locator("option:checked").textContent()).toBe(
      "Rehaussement de cils",
    );
    await selector.selectOption("salon");
    await page.locator('[data-agenda-format="salon"]').waitFor();
    expect(await noSideScroll(page)).toBe(true);

    const other = await signedInPage(pro.browser, {
      width: 1280,
      appearance: look("studio"),
    });
    try {
      for (const style of ["studio", "carnet", "classique"]) {
        await wear(pro.browser, look(style));
        await other.page.goto(APP + "/app");
        const saved = other.page.getByRole("combobox", {
          name: "Format d’agenda",
        });
        await saved.waitFor();
        expect(await saved.inputValue()).toBe("salon");
        await other.page
          .getByRole("button", { name: "Mois", exact: true })
          .click();
        await other.page
          .getByRole("button", { name: /Lou Visite/ })
          .first()
          .waitFor();
        expect(await noSideScroll(other.page)).toBe(true);
      }
      expect(other.errors).toEqual([]);
    } finally {
      await other.page.context().close();
    }

    await db.query("select public.set_site_plan($1, 'core')", [pro.businessId]);
    await selector.selectOption("visual");
    await page
      .getByRole("alert")
      .filter({ hasText: "Le format n’a pas pu être enregistré" })
      .waitFor();
    expect(await selector.inputValue()).toBe("salon");
    await page.reload();
    expect(await selector.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
});
