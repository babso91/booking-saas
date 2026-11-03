import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import {
  expectAccessible,
  hydrated,
  look,
  noSideScroll,
  signedInPage,
} from "./support/ecrin";
import { capture } from "./support/capture";
import { APP, db, professionalWithVisit } from "./support/studio";

// Carnet in a real browser against the real backend: the agenda is read after
// hydration, so what matters is the live page and what the network carries,
// never the HTML of the first answer.

const CARNET = look("carnet");

/** The style really applied, read in the live page. */
const applied = (page: Page) =>
  page.evaluate(() => ({
    style: document.documentElement.getAttribute("data-style"),
    frame: document.querySelectorAll("[data-carnet-frame]").length,
    heading: getComputedStyle(document.querySelector("h1") ?? document.body)
      .fontFamily,
  }));

const parisDate = (plusDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(Date.now() + plusDays * 86_400_000),
  );

// Two weeks ahead: never the hour of the run, never the visit going on.
const FUTURE = parisDate(14);

const visitCount = async (businessId: string) =>
  Number(
    (
      await db.query<{ count: string }>(
        `select count(*) from public.appointments
         where business_id = $1 and status = 'confirmed'
           and starts_at >= $2::date`,
        [businessId, FUTURE],
      )
    ).rows[0]!.count,
  );

describe("Carnet in a browser", () => {
  it("hydrates on her real visits: the Carnet frame, the card, focus back", async () => {
    const { browser } = await professionalWithVisit("Maëlys", "Inès");
    const { page, errors } = await signedInPage(browser, {
      appearance: CARNET,
    });
    await page.goto(`${APP}/app`);

    const visit = await hydrated(
      page.getByRole("button", { name: /Inès Visite/ }).first(),
    );
    const live = await applied(page);
    expect(live.style).toBe("carnet");
    expect(live.frame).toBe(1);
    expect(live.heading).toContain("Newsreader");
    expect(await page.getByRole("group", { name: /^Journée du/ }).count()).toBe(
      7,
    );

    await visit.click();
    const card = page.getByRole("dialog");
    await card.getByRole("heading", { name: "Rendez-vous" }).waitFor();
    expect(await card.innerText()).toContain("Inès Visite");
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "detached" });
    expect(
      await page.evaluate(() => document.activeElement?.textContent),
    ).toContain("Inès Visite");
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("the home reads the same visit and leads to its card; the keyboard reaches it", async () => {
    const { browser } = await professionalWithVisit("Alma", "Lou");
    const { page } = await signedInPage(browser, { appearance: CARNET });
    await page.goto(`${APP}/app/today`);
    const link = await hydrated(
      page
        .getByRole("region", { name: "Rendez-vous du jour" })
        .getByRole("link", { name: /Lou Visite/ }),
    );
    expect((await page.locator("body").innerText()).match(/\d\s?€/)).toBeNull();

    // Tab order starts in her frame, and focus shows.
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return getComputedStyle(element).outlineStyle;
    });
    expect(outline).not.toBe("none");

    await link.click();
    await page.waitForURL(/\/app\?date=.*&rdv=/);
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("dialog").innerText()).toContain("Lou Visite");
    await page.context().close();
  });

  it("another business's visit: nothing on screen, nothing on the network; her own opens", async () => {
    const mine = await professionalWithVisit("Rana", "Rose");
    const theirs = await professionalWithVisit("Jade", "Zélie");
    const { page } = await signedInPage(mine.browser, { appearance: CARNET });

    const answers: { what: string; body: string }[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const response = await route.fetch({ maxRedirects: 0 });
      answers.push({
        what: `${request.method()} ${request.url()} ${response.status()}`,
        body: await response.text(),
      });
      await route.fulfill({ response });
    });

    const forbidden = ["Zélie", theirs.businessId, theirs.clientEmail];
    for (const path of [
      `/app?date=${parisDate()}&rdv=${theirs.appointmentId}`,
      "/app/today",
    ]) {
      await page.goto(`${APP}${path}`);
      await page
        .getByRole(path === "/app/today" ? "link" : "button", {
          name: /Rose Visite/,
        })
        .first()
        .waitFor();
      await page.waitForLoadState("networkidle");
      expect(await page.getByRole("dialog").count(), path).toBe(0);
      const text = await page.locator("body").innerText();
      const html = await page.content();
      for (const value of forbidden) {
        expect(text, path).not.toContain(value);
        expect(html, path).not.toContain(value);
      }
    }

    // The capture really saw the read of her own data…
    expect(
      answers.some(
        ({ what, body }) => what.startsWith("POST") && body.includes("Rose"),
      ),
    ).toBe(true);
    // …and no answer carried theirs.
    for (const { what, body } of answers)
      for (const value of forbidden)
        expect(body.includes(value), `${value} in ${what}`).toBe(false);
    await page.unrouteAll({ behavior: "ignoreErrors" });

    await page.goto(`${APP}/app?date=${parisDate()}&rdv=${mine.appointmentId}`);
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("dialog").innerText()).toContain("Rose");
    await page.context().close();
  });

  it("creates through the real form; the server refuses the overlap, in the page and in the database", async () => {
    const { browser, businessId } = await professionalWithVisit("Nina", "Eva");
    const { page } = await signedInPage(browser, { appearance: CARNET });
    await page.goto(`${APP}/app?date=${FUTURE}`);

    const book = async (time: string) => {
      await (
        await hydrated(
          page.getByRole("button", { name: /Nouveau rendez-vous/ }).first(),
        )
      ).click();
      const form = page.getByRole("dialog");
      const service = form.getByLabel("Prestation");
      await service.waitFor();
      await vi.waitFor(async () =>
        expect(await service.isDisabled()).toBe(false),
      );
      const value = await service
        .locator("option", { hasText: "Rehaussement de cils" })
        .first()
        .getAttribute("value");
      await service.selectOption(value!);
      await form.getByLabel("Date").fill(FUTURE);
      await form.getByLabel("Heure").fill(time);
      await form.getByLabel("Rechercher une cliente").fill("Eva");
      await form.getByRole("button", { name: /Eva Visite/ }).click();
      await form.getByRole("button", { name: "Créer le rendez-vous" }).click();
      return form;
    };

    await book("10:00");
    await vi.waitFor(async () => expect(await visitCount(businessId)).toBe(1), {
      timeout: 15_000,
    });
    // The form gives way to the server's appointment, in its card.
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: "Rendez-vous", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: /10:00, Eva Visite/ })
      .first()
      .waitFor();

    const refused = await book("10:30");
    await refused
      .getByText(
        "Ce créneau vient d’être pris ou est indisponible. Choisis-en un autre.",
      )
      .waitFor();
    expect(await refused.getByLabel("Heure").inputValue()).toBe("10:30");
    expect(await visitCount(businessId)).toBe(1);
    await page.context().close();
  });

  // Next.js runs server actions one at a time: while the agenda's read is
  // held, every later action waits behind it, in the page as in real life.
  const holdAgendaRead = async (page: Page) => {
    let release = () => {};
    const gate = new Promise<void>((done) => (release = done));
    await page.route(
      (url) => url.pathname === "/app",
      async (route) => {
        if (route.request().postData()?.includes("startDate")) await gate;
        await route.continue();
      },
    );
    return release;
  };

  it("phone: a link's card never opens over a form she started; her draft stays", async () => {
    const { browser, appointmentId } = await professionalWithVisit(
      "Mila",
      "Iris",
    );
    const { page } = await signedInPage(browser, {
      appearance: CARNET,
      width: 390,
      height: 800,
      phone: true,
    });
    const release = await holdAgendaRead(page);
    await page.goto(`${APP}/app?date=${parisDate()}&rdv=${appointmentId}`);
    await (
      await hydrated(page.getByRole("button", { name: "Nouveau rendez-vous" }))
    ).click();
    // One day on screen: the form needs no answer to open.
    const form = page.getByRole("dialog");
    await form.getByLabel(/Note interne/).fill("Brouillon");
    release();

    await page
      .locator("button", { hasText: "Iris Visite" })
      .first()
      .waitFor({ state: "attached" });
    await page.waitForLoadState("networkidle");
    expect(await page.getByRole("dialog").count()).toBe(1);
    await form.getByRole("heading", { name: "Nouveau rendez-vous" }).waitFor();
    expect(await form.getByLabel(/Note interne/).inputValue()).toBe(
      "Brouillon",
    );
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.context().close();
  });

  it("computer: asking for a form during the read wins over the link's card", async () => {
    const { browser, appointmentId } = await professionalWithVisit(
      "Dina",
      "Noa",
    );
    const { page } = await signedInPage(browser, { appearance: CARNET });
    const release = await holdAgendaRead(page);
    await page.goto(`${APP}/app?date=${parisDate()}&rdv=${appointmentId}`);
    await (
      await hydrated(
        page.getByRole("button", { name: /Nouveau rendez-vous/ }).first(),
      )
    ).click();
    release();

    const form = page.getByRole("dialog");
    await form.getByRole("heading", { name: "Nouveau rendez-vous" }).waitFor();
    await page.waitForLoadState("networkidle");
    expect(await page.getByRole("dialog").count()).toBe(1);
    expect(await form.innerText()).not.toContain("Noa Visite");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.context().close();
  });

  it("« Noter » from another page opens the agenda's own form, once", async () => {
    const { browser } = await professionalWithVisit("Rita", "Alix");
    const { page } = await signedInPage(browser, { appearance: CARNET });
    await page.goto(`${APP}/app/clients`);
    await (
      await hydrated(page.getByRole("link", { name: /Noter un rendez-vous/ }))
    ).click();
    const form = page.getByRole("dialog");
    await form.getByRole("heading", { name: "Nouveau rendez-vous" }).waitFor();
    await page.waitForURL((url) => !url.search.includes("noter"));
    await page.reload();
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.waitForLoadState("networkidle");
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.context().close();
  });

  it("her paper and ink are kept on her account, and come back after a reload", async () => {
    const { browser, businessId } = await professionalWithVisit("Ines", "Rosa");
    const { page, errors } = await signedInPage(browser, {
      appearance: CARNET,
    });
    await page.goto(`${APP}/app/settings/appearance`);
    // Her click lands on the label: the radio itself is visually hidden.
    const choose = async (name: string) =>
      (
        await hydrated(page.locator("label", { hasText: name }).first())
      ).click();
    const row = async () =>
      (
        await db.query(
          `select style, ambiance, color_mode, accent from public.member_preferences
           where business_id = $1`,
          [businessId],
        )
      ).rows[0];

    await choose("Encre bleue");
    await choose("Sombre");
    await choose("Prune");
    await vi.waitFor(
      async () =>
        expect(await row()).toMatchObject({
          style: "carnet",
          ambiance: "lin",
          color_mode: "dark",
          accent: expect.stringMatching(/^#7a3e66$/i),
        }),
      { timeout: 15_000 },
    );
    await page.reload();
    await page.getByRole("heading", { name: "Apparence" }).waitFor();
    expect(await applied(page)).toMatchObject({ style: "carnet", frame: 1 });
    expect(
      await page.getByRole("radio", { name: /^Encre bleue/ }).isChecked(),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("malformed links open nothing and break nothing", async () => {
    const { browser } = await professionalWithVisit("Lina", "Nour");
    const { page, errors } = await signedInPage(browser, {
      appearance: CARNET,
    });
    for (const query of [
      "rdv=not-a-uuid",
      "rdv=../../app/clients",
      "date=hier",
    ]) {
      await page.goto(`${APP}/app?${query}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.waitForLoadState("networkidle");
      expect(await page.getByRole("dialog").count(), query).toBe(0);
    }
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("back on the tab after a while, a booking made meanwhile appears", async () => {
    const { browser, businessId } = await professionalWithVisit("Jana", "Ada");
    const { page } = await signedInPage(browser, { appearance: CARNET });
    await page.goto(`${APP}/app?date=${FUTURE}`);
    await hydrated(
      page.getByRole("button", { name: /Nouveau rendez-vous/ }).first(),
    );
    await page
      .getByRole("group", { name: /^Journée du/ })
      .first()
      .waitFor();
    await page.waitForLoadState("networkidle");

    const setVisibility = (state: string) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => value,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);

    await setVisibility("hidden");
    await db.query(
      `insert into public.appointments (
         business_id, client_id, service_id, starts_at, ends_at, status,
         service_name_snapshot, duration_minutes_snapshot,
         price_cents_snapshot, buffer_minutes_snapshot
       )
       select b.id, c.id, s.id,
              ($2::date + time '15:00') at time zone 'Europe/Paris',
              ($2::date + time '16:15') at time zone 'Europe/Paris',
              'confirmed', s.name, 75, 6000, 0
       from public.businesses b
       join public.clients c on c.business_id = b.id
       join public.services s on s.business_id = b.id
       where b.id = $1`,
      [businessId, FUTURE],
    );
    await page.evaluate(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + 2 * 60_000;
    });
    await setVisibility("visible");
    await page.getByRole("button", { name: /15:00, Ada Visite/ }).waitFor();
    await page.context().close();
  });

  it("changes style in the page and back; each stays after a reload", async () => {
    const { browser } = await professionalWithVisit("Sana", "Maya");
    const { page, errors } = await signedInPage(browser, {
      appearance: CARNET,
    });
    await page.goto(`${APP}/app/settings/appearance`);

    const choose = async (name: string) =>
      (
        await hydrated(page.locator("label", { hasText: name }).first())
      ).click();
    const expectLive = async (style: string, frame: number, chosen = true) => {
      await vi.waitFor(async () =>
        expect(await applied(page)).toMatchObject({ style, frame }),
      );
      // Reloaded once her account holds it: before, the page would still be
      // saving it, and the server rightly answers with the previous style.
      if (chosen) await page.getByText("Enregistré sur ton compte.").waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Apparence" }).waitFor();
      expect(await applied(page), `${style} after reload`).toMatchObject({
        style,
        frame,
      });
    };

    await expectLive("carnet", 1, false);
    await choose("Studio");
    await expectLive("studio", 0);
    await choose("Classique");
    await expectLive("classique", 0);
    await choose("Écrin");
    await expectLive("ecrin", 0);
    await choose("Carnet");
    await expectLive("carnet", 1);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it.each([
    [CARNET, "clair"],
    [look("carnet", "dark"), "sombre"],
    ["lin.dark.standard.-.carnet", "encre bleue, sombre"],
    ["sauge.light.standard.-.carnet", "olive"],
  ])(
    "axe: home, week, day and card (%s, %s)",
    async (appearance, label) => {
      const { browser } = await professionalWithVisit("Noor", "Elia");
      const { page } = await signedInPage(browser, { appearance });
      await page.goto(`${APP}/app/today`);
      await hydrated(page.getByRole("link", { name: /Elia Visite/ }).first());
      await expectAccessible(page, "home");
      await capture(page, `agenda ${label} home`);

      await page.goto(`${APP}/app`);
      const visit = await hydrated(
        page.getByRole("button", { name: /Elia Visite/ }).first(),
      );
      await expectAccessible(page, "week");
      await capture(page, `agenda ${label} week`);
      await visit.click();
      await page.getByRole("dialog").waitFor();
      await expectAccessible(page, "card");
      await capture(page, `agenda ${label} card`);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });

      await page.getByRole("button", { name: "Jour", exact: true }).click();
      await page.getByRole("list", { name: "Ordre du jour" }).waitFor();
      await expectAccessible(page, "day");
      await capture(page, `agenda ${label} day`);
      await page.context().close();
    },
    120_000,
  );
});

describe("Carnet in a phone", () => {
  it.each([320, 375, 390])(
    "at %i px: written day, thumb controls, menu, rooms, no side scroll",
    async (width) => {
      const { browser } = await professionalWithVisit("Hana", "Sara");
      const { page, errors } = await signedInPage(browser, {
        appearance: CARNET,
        width,
        height: 700,
        phone: true,
      });
      await page.goto(`${APP}/app`);
      await page.getByRole("list", { name: "Ordre du jour" }).waitFor();
      const visit = await hydrated(
        page.getByRole("button", { name: /Sara Visite/ }).first(),
      );
      expect(await noSideScroll(page)).toBe(true);
      await expectAccessible(page, `${width} day`);
      await capture(page, `phone ${width} day`);

      // The card from the thread.
      await visit.click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });

      // Options: entirely on screen, really usable.
      await page.getByRole("button", { name: "Options de l’agenda" }).click();
      const menu = page.locator("#carnet-agenda-options");
      await menu.waitFor();
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(700);
      await menu.getByLabel("Afficher les annulés").click();
      expect(await menu.getByLabel("Afficher les annulés").isChecked()).toBe(
        true,
      );
      await page.keyboard.press("Escape");

      // Away from today, back in one tap.
      await page.getByRole("button", { name: "Semaine suivante" }).click();
      await page.getByRole("button", { name: "Aujourd’hui" }).click();
      await page
        .getByRole("button", { name: /Sara Visite/ })
        .first()
        .waitFor();
      expect(await noSideScroll(page)).toBe(true);

      // Rooms: under the thumb, and the rest in « Plus ».
      const nav = page.getByRole("navigation", {
        name: "Navigation principale",
      });
      await nav.getByRole("button", { name: "Plus" }).click();
      await page
        .getByRole("dialog")
        .getByRole("link", { name: /Horaires/ })
        .click();
      await page.waitForURL("**/app/settings/hours");
      await page.getByRole("heading", { name: "Horaires" }).waitFor();
      await nav.getByRole("link", { name: "Clientes" }).click();
      await page.waitForURL("**/app/clients");
      expect(
        await nav
          .getByRole("link", { name: "Clientes" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(errors).toEqual([]);
      await page.context().close();
    },
    120_000,
  );
});
