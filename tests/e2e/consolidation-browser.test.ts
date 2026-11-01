import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import {
  expectAccessible,
  hydrated,
  look,
  signedInPage,
} from "./support/ecrin";
import { APP, db, professionalWithVisit } from "./support/studio";

// What the cross-style corrections must keep true, in a real browser with a
// real session: focus never lost, names that contain what is seen, and free
// time that the server alone turns into an appointment.

const parisDate = (plusDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(Date.now() + plusDays * 86_400_000),
  );
const FUTURE = parisDate(14);

/** Where focus is, readable in a failure message. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element === document.body
      ? "BODY"
      : `${element?.tagName}:${element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 40)}`;
  });

const TRIGGER = "BUTTON:Options de l’agenda";

describe.each(["ecrin", "studio"])("the options menu — %s", (style) => {
  const openMenu = async (width: number, phone = true) => {
    const { browser } = await professionalWithVisit("Rita", "Maud");
    const { page, errors } = await signedInPage(browser, {
      appearance: look(style),
      width,
      height: 760,
      phone,
    });
    await page.goto(`${APP}/app`);
    await hydrated(page.getByRole("button", { name: /Maud Visite/ }).first());
    const trigger = await hydrated(
      page.getByRole("button", { name: "Options de l’agenda" }),
    );
    await trigger.focus();
    await page.keyboard.press("Enter");
    const cancelled = page.getByLabel("Afficher les annulés");
    await cancelled.waitFor();
    return { page, errors, cancelled };
  };
  const closed = (page: Page) =>
    page
      .getByLabel("Afficher les annulés")
      .waitFor({ state: "detached", timeout: 5_000 });

  it.each([320, 375, 390])(
    "%i px: Escape, an option, its panel, and clicks outside",
    async (width) => {
      const { page, errors, cancelled } = await openMenu(width);

      // Escape from the option: back on the button, not on the page.
      await cancelled.focus();
      await page.keyboard.press("Escape");
      await closed(page);
      expect(await focused(page)).toBe(TRIGGER);

      // Activating an option that stays: focus stays on it, the menu too.
      await page.keyboard.press("Enter");
      await cancelled.waitFor();
      await cancelled.focus();
      await page.keyboard.press("Space");
      expect(await cancelled.isChecked()).toBe(true);
      await page.waitForLoadState("networkidle");
      expect(await focused(page)).toMatch(/^INPUT:/);
      await page.keyboard.press("Escape");
      await closed(page);

      // An option that opens a panel: its panel gives focus back to the button.
      await page.keyboard.press("Enter");
      const block = page.getByRole("button", { name: "Bloquer un créneau" });
      await block.waitFor();
      await block.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      expect(await focused(page)).toBe(TRIGGER);

      // A click on nothing: nothing lost.
      await page.keyboard.press("Enter");
      await cancelled.waitFor();
      await cancelled.focus();
      await page.locator("main header p").first().click();
      await closed(page);
      expect(await focused(page)).toBe(TRIGGER);

      // A click on something else: focus is where she went, never pulled back.
      await page.keyboard.press("Enter");
      await cancelled.waitFor();
      const next = page
        .getByRole("button", { name: "Semaine précédente" })
        .first();
      await next.click();
      await closed(page);
      expect(await focused(page)).toBe("BUTTON:Semaine précédente");

      // « Aujourd’hui » goes away once pressed: focus stays near.
      await page.getByRole("button", { name: "Aujourd’hui" }).click();
      await page.getByRole("button", { name: "Aujourd’hui" }).waitFor({
        state: "detached",
      });
      expect(await focused(page)).toMatch(/^H1:/);

      expect(errors).toEqual([]);
      await page.context().close();
    },
    120_000,
  );

  it("Escape after she has moved on leaves her where she is", async () => {
    const { page, cancelled } = await openMenu(390);
    await cancelled.focus();
    await page.keyboard.press("Tab");
    const there = await focused(page);
    expect(there).not.toBe("BODY");
    await page.keyboard.press("Escape");
    await closed(page);
    expect(await focused(page)).toBe(there);
    await page.context().close();
  });

  it("a touch scroll outside closes it and takes no focus back", async () => {
    const { page, cancelled } = await openMenu(390);
    await page.setViewportSize({ width: 390, height: 560 });
    await cancelled.focus();
    // The page's scrolling area, and where it stands: the finger starts in it.
    const area = await page.evaluate(() => {
      const element = [...document.querySelectorAll("*")]
        .filter(
          (candidate) =>
            /auto|scroll/.test(getComputedStyle(candidate).overflowY) &&
            candidate.scrollHeight > candidate.clientHeight + 100,
        )
        .sort((a, b) => b.clientHeight - a.clientHeight)[0]!;
      element.setAttribute("data-scrolling-area", "");
      document.addEventListener(
        "pointercancel",
        () => document.documentElement.setAttribute("data-cancelled", ""),
        true,
      );
      const { top, bottom } = element.getBoundingClientRect();
      // Lowest point of the area that is the area: a bar may float over it.
      let from = bottom - 10;
      while (
        from > top &&
        !element.contains(document.elementFromPoint(40, from))
      ) {
        from -= 10;
      }
      return { top, from, scrollTop: element.scrollTop };
    });

    const touch = await page.context().newCDPSession(page);
    const point = (y: number) => [{ x: 40, y }];
    const { from } = area;
    const distance = from - area.top - 10;
    expect(distance).toBeGreaterThan(100);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(from),
    });
    for (let step = 1; step <= 8; step += 1) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(from - (distance * step) / 8),
      });
      await page.waitForTimeout(16);
    }
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await closed(page);

    // Chromium did take it for a scroll, and it scrolled: this test proves
    // nothing otherwise.
    await page.waitForSelector("html[data-cancelled]", { state: "attached" });
    await page.waitForFunction(
      (before) =>
        document.querySelector("[data-scrolling-area]")!.scrollTop !== before,
      area.scrollTop,
    );
    expect(await focused(page)).toBe("BODY");
    await page.context().close();
  });

  it("the button itself goes away (the screen widens): focus lands on the title", async () => {
    const { page, cancelled } = await openMenu(600, false);
    await cancelled.focus();
    await page.setViewportSize({ width: 1440, height: 800 });
    await page
      .getByRole("button", { name: "Options de l’agenda" })
      .waitFor({ state: "detached" });
    expect(await focused(page)).toMatch(/^H1:/);
    await page.context().close();
  });

  it("1440 px: no menu; the same controls keep focus by keyboard", async () => {
    const { browser } = await professionalWithVisit("Ines", "Paule");
    const { page } = await signedInPage(browser, {
      appearance: look(style),
      width: 1440,
      height: 800,
    });
    await page.goto(`${APP}/app`);
    await hydrated(page.getByRole("button", { name: /Paule Visite/ }).first());
    expect(
      await page.getByRole("button", { name: "Options de l’agenda" }).count(),
    ).toBe(0);
    const day = page.getByRole("button", { name: "Jour", exact: true });
    await day.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("list", { name: "Déroulé de la journée" }).waitFor();
    expect(await focused(page)).toBe("BUTTON:Jour");
    await page.context().close();
  });
});

describe.each(["ecrin", "studio"])(
  "what she sees she can say — %s",
  (style) => {
    it.each([
      { name: "Lou", shown: "AL", width: 1440, phone: false },
      {
        name: "Marie-Alexandrine de la Tour d’Auvergne",
        shown: "AM",
        width: 390,
        phone: true,
      },
    ])(
      "the monogram of « Atelier $name », $width px, by keyboard",
      async ({ name, shown, width, phone }) => {
        const { browser } = await professionalWithVisit(name, "Solène");
        const { page } = await signedInPage(browser, {
          appearance: look(style),
          width,
          height: 800,
          phone,
        });
        await page.goto(`${APP}/app`);
        await hydrated(
          page.getByRole("button", { name: /Solène Visite/ }).first(),
        );

        // Asked for by what is written on it, as a voice command would.
        const monogram = page.getByRole("button", {
          name: `${shown}, Atelier ${name} : réglages et compte`,
          exact: true,
        });
        expect(await monogram.isVisible()).toBe(true);
        expect((await monogram.innerText()).trim()).toBe(shown);

        await monogram.focus();
        await page.keyboard.press("Enter");
        await page.getByRole("dialog").waitFor();
        await expectAccessible(page, "sheet");
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "detached" });
        expect(
          await monogram.evaluate((el) => el === document.activeElement),
        ).toBe(true);
        await expectAccessible(page, "agenda");
        await page.context().close();
      },
      120_000,
    );
  },
);

describe("Classique", () => {
  it("axe with WCAG 2.5.3 on its agenda, and a header that stays in the page at 320 px", async () => {
    const { browser } = await professionalWithVisit("Anne", "Zoé");
    const { page } = await signedInPage(browser, {
      appearance: look("classique"),
    });
    await page.goto(`${APP}/app`);
    await hydrated(page.getByRole("button", { name: /Zoé Visite/ }).first());
    await expectAccessible(page, "classique agenda");

    const { page: phone } = await signedInPage(browser, {
      appearance: look("classique"),
      width: 320,
      height: 700,
      phone: true,
    });
    // The week across the New Year, at its longest.
    await phone.goto(`${APP}/app?date=2026-12-30`);
    await phone.getByRole("heading", { level: 1 }).first().waitFor();
    await phone.waitForLoadState("networkidle");
    expect(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.context().close();
    await phone.context().close();
  }, 120_000);
});

describe("free time and the server", () => {
  it("60 min + 15 min of buffer: refused in 70 free minutes, accepted in 75", async () => {
    const { browser, businessId } = await professionalWithVisit("Tess", "Mona");
    const { rows } = await db.query<{ id: string }>(
      `insert into public.services
         (business_id, name, duration_minutes, price_cents)
       values ($1, 'Soin avec tampon', 60, 5000) returning id`,
      [businessId],
    );
    // The buffer is the business's setting, frozen on each appointment.
    await db.query(
      "update public.business_settings set buffer_minutes = 15 where business_id = $1",
      [businessId],
    );
    // What ends her free time: a visit at 12:00.
    await db.query(
      `insert into public.appointments (
         business_id, client_id, service_id, starts_at, ends_at, status,
         service_name_snapshot, duration_minutes_snapshot,
         price_cents_snapshot, buffer_minutes_snapshot
       )
       select b.id, c.id, $3, ($2::date + time '12:00') at time zone 'Europe/Paris',
              ($2::date + time '13:00') at time zone 'Europe/Paris',
              'confirmed', 'Soin avec tampon', 60, 5000, 0
       from public.businesses b
       join public.clients c on c.business_id = b.id
       where b.id = $1`,
      [businessId, FUTURE, rows[0]!.id],
    );
    const count = async () =>
      Number(
        (
          await db.query<{ count: string }>(
            `select count(*) from public.appointments
             where business_id = $1 and status = 'confirmed'
               and starts_at >= $2::date and service_name_snapshot = 'Soin avec tampon'`,
            [businessId, FUTURE],
          )
        ).rows[0]!.count,
      );

    const { page } = await signedInPage(browser);
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
      await service.selectOption(rows[0]!.id);
      await form.getByLabel("Date").fill(FUTURE);
      await form.getByLabel("Heure").fill(time);
      await form.getByLabel("Rechercher une cliente").fill("Mona");
      await form.getByRole("button", { name: /Mona Visite/ }).click();
      await form.getByRole("button", { name: "Créer le rendez-vous" }).click();
      return form;
    };

    const refused = await book("10:50");
    await refused
      .getByText(
        "Ce créneau vient d’être pris ou est indisponible. Choisis-en un autre.",
      )
      .waitFor();
    expect(await count()).toBe(1);

    await refused.getByLabel("Heure").fill("10:45");
    await refused.getByRole("button", { name: "Créer le rendez-vous" }).click();
    await vi.waitFor(async () => expect(await count()).toBe(2), {
      timeout: 15_000,
    });
    await page.context().close();
  }, 120_000);
});
