import type { Page, Route } from "playwright";
import { describe, expect, it, vi } from "vitest";

import {
  applied,
  expectAccessible,
  hydrated,
  look,
  noSideScroll,
  signedInPage,
} from "./support/ecrin";
import { APP, db, professionalWithVisit, type Browser } from "./support/studio";

// Her appearance as her account keeps it: real page, real session, real
// Server Actions and PostgreSQL, the result read in the database. No waiting
// on time: answers are held by the test (page.route), and the only clock
// moved is the page's own (a timeout).

const SETTINGS = `${APP}/app/settings/appearance`;

type Row = {
  style: string;
  ambiance: string;
  color_mode: string;
  accent: string | null;
  motion: string;
  version: string;
};

const rowOf = async (browser: Browser): Promise<Row | null> => {
  const { rows } = await db.query<Row>(
    `select style, ambiance, color_mode, accent, motion, version
       from public.member_preferences
      where business_id = $1 and user_id = $2`,
    [browser.member!.businessId, browser.member!.userId],
  );
  return rows[0] ?? null;
};

/** Until the database says so: a write's answer may still be on its way. */
const inDatabase = (browser: Browser, expected: Partial<Row>) =>
  vi.waitFor(async () => expect(await rowOf(browser)).toMatchObject(expected), {
    timeout: 15_000,
    interval: 100,
  });

const open = async (browser: Browser, options: { width?: number } = {}) => {
  const { page, errors } = await signedInPage(browser, {
    appearance: null,
    ...options,
  });
  await openSettings(page);
  return { page, errors };
};

const openSettings = async (page: Page) => {
  await page.goto(SETTINGS);
  await hydrated(
    page.getByRole("radio", { name: /^Classique|^Studio/ }).first(),
  );
};

/** As she does: the whole card is the target. */
const choose = (page: Page, name: RegExp) =>
  page
    .locator("label")
    .filter({ has: page.getByRole("radio", { name }) })
    .click();
/** The style applied once the page has hydrated (<html> carries it then). */
const drawn = (page: Page, style: string) =>
  vi.waitFor(async () => expect((await applied(page)).style).toBe(style), {
    timeout: 15_000,
    interval: 50,
  });
const said = (page: Page, text: string) =>
  page.getByRole("status").filter({ hasText: text }).first().waitFor();
const SAVED = "Enregistré sur ton compte.";

/** She comes back to this tab: what the browser tells the page. */
const comeBack = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("focus")));

const actionBody = (route: Route) => route.request().postData() ?? "";
const isAction = (route: Route) =>
  route.request().method() === "POST" &&
  route.request().headers()["next-action"] !== undefined;
const isSave = (route: Route) =>
  isAction(route) && actionBody(route).includes('"changes"');
const isRead = (route: Route) =>
  isAction(route) && !actionBody(route).includes('"context"');

/** Holds the first request matching, until the test lets it go. */
async function hold(page: Page, matches: (route: Route) => boolean) {
  let held: Route | null = null;
  let arrived!: () => void;
  const here = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route("**/app/**", (route) => {
    if (held === null && matches(route)) {
      held = route;
      arrived();
      return;
    }
    return route.fallback();
  });
  return {
    here,
    release: async () => {
      await page.unroute("**/app/**");
      await held!.continue();
    },
  };
}

describe("her choice follows her", () => {
  it("chooses Écrin, reloads, and finds Écrin; so does her other device", async () => {
    const { browser } = await professionalWithVisit("Maëlys", "Inès");
    const { page, errors } = await open(browser);
    expect(await rowOf(browser)).toBeNull();

    await choose(page, /^Écrin/);
    expect((await applied(page)).style).toBe("ecrin");
    await said(page, SAVED);
    expect(await rowOf(browser)).toMatchObject({
      style: "ecrin",
      version: "1",
    });

    // The first HTML already is Écrin: nothing to flash from.
    const html = (await browser.get("/app")).html;
    expect(html).toContain('data-style="ecrin"');
    expect(html).toContain("ecrin-ground");

    await page.reload();
    await hydrated(page.getByRole("radio", { name: /^Écrin/ }));
    await drawn(page, "ecrin");
    expect(await page.getByRole("radio", { name: /^Écrin/ }).isChecked()).toBe(
      true,
    );

    const other = await signedInPage(browser, {
      appearance: null,
      width: 390,
      phone: true,
    });
    await other.page.goto(`${APP}/app`);
    await drawn(other.page, "ecrin");

    expect(errors).toEqual([]);
    await page.context().close();
    await other.page.context().close();
  });

  it.each([
    [/^Sombre/, { color_mode: "dark" }],
    [/^Aucune/, { motion: "none" }],
    [/^Lin/, { ambiance: "lin" }],
  ])("%s reaches her account", async (name, expected) => {
    const { browser } = await professionalWithVisit("Alma", "Rose");
    const { page } = await open(browser);
    await choose(page, name);
    await inDatabase(browser, expected);
    await page.context().close();
  });

  it("an accent reaches her account, and a style starts from its own", async () => {
    const { browser } = await professionalWithVisit("Ambre", "Rose");
    const { page } = await open(browser);
    await page
      .locator('input[type="color"]')
      .evaluate((input: HTMLInputElement) => {
        const set = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        set.call(input, "#336699");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await inDatabase(browser, { accent: "#336699" });
    await choose(page, /^Studio/);
    await inDatabase(browser, { style: "studio", accent: null });
    await page.context().close();
  });

  it("the style radio keeps the focus by keyboard, through the change of frame", async () => {
    const { browser } = await professionalWithVisit("Luz", "Rose");
    const { page } = await open(browser);
    await page.getByRole("radio", { name: /^Classique/ }).focus();
    await page.keyboard.press("ArrowRight");
    await inDatabase(browser, { version: "1" });
    const { style } = (await rowOf(browser))!;
    expect(style).not.toBe("classique");
    await drawn(page, style);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("value")),
    ).toBe(style);
    await page.context().close();
  });
});

describe("two tabs", () => {
  const twoTabs = async (name: string) => {
    const { browser } = await professionalWithVisit(name, "Rose");
    const { page: first } = await open(browser);
    const second = await first.context().newPage();
    await openSettings(second);
    return { browser, first, second };
  };

  it("different settings: both are kept", async () => {
    const { browser, first, second } = await twoTabs("Nina");
    await choose(first, /^Sombre/);
    await said(first, SAVED);
    // Second still read the account before: stale, then applied on the new one.
    await choose(second, /^Aucune/);
    await said(second, SAVED);
    expect(await rowOf(browser)).toMatchObject({
      color_mode: "dark",
      motion: "none",
    });

    await comeBack(first);
    await vi.waitFor(async () =>
      expect(
        await first.getByRole("radio", { name: /^Aucune/ }).isChecked(),
      ).toBe(true),
    );
    await first.context().close();
  });

  it("the same setting: the last choice is kept, and the other tab shows it", async () => {
    const { browser, first, second } = await twoTabs("Oda");
    await choose(first, /^Sombre/);
    await said(first, SAVED);
    await choose(second, /^Comme l’appareil/);
    await said(second, SAVED);
    expect(await rowOf(browser)).toMatchObject({ color_mode: "system" });

    await comeBack(first);
    await vi.waitFor(async () =>
      expect(
        await first
          .getByRole("radio", { name: /^Comme l’appareil/ })
          .isChecked(),
      ).toBe(true),
    );
    await first.context().close();
  });
});

describe("when answers do not come as hoped", () => {
  it("a save fails, she is told, and it goes through by itself", async () => {
    const { browser } = await professionalWithVisit("Pia", "Rose");
    const { page } = await open(browser);
    let failed = 0;
    await page.route("**/app/**", (route) => {
      if (isSave(route) && failed === 0) {
        failed += 1;
        return route.abort();
      }
      return route.fallback();
    });
    await choose(page, /^Sombre/);
    await said(page, "Pas encore enregistré");
    expect(await rowOf(browser)).toBeNull();
    expect(await page.getByRole("radio", { name: /^Sombre/ }).isChecked()).toBe(
      true,
    );
    await said(page, SAVED);
    expect(await rowOf(browser)).toMatchObject({ color_mode: "dark" });
    await page.context().close();
  });

  it("the backend is away for a while: the choice stays and arrives after", async () => {
    const { browser } = await professionalWithVisit("Rae", "Rose");
    const { page, errors } = await open(browser);
    await page.route("**/app/**", (route) =>
      isAction(route)
        ? route.fulfill({ status: 503, body: "unavailable" })
        : route.fallback(),
    );
    await choose(page, /^Écrin/);
    await said(page, "Pas encore enregistré");
    expect((await applied(page)).style).toBe("ecrin");
    expect(await rowOf(browser)).toBeNull();

    await page.unroute("**/app/**");
    await said(page, SAVED);
    expect(await rowOf(browser)).toMatchObject({ style: "ecrin" });
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("a stale read answered after a recent choice does not undo it", async () => {
    const { browser } = await professionalWithVisit("Sia", "Rose");
    const { page } = await open(browser);
    const read = await hold(page, isRead);
    await comeBack(page);
    await read.here;

    // Sent before her choice, so what it brings is older than it.
    await choose(page, /^Sombre/);
    await read.release();
    await said(page, SAVED);
    expect(await page.getByRole("radio", { name: /^Sombre/ }).isChecked()).toBe(
      true,
    );
    expect(await rowOf(browser)).toMatchObject({ color_mode: "dark" });
    await page.context().close();
  });

  it("the route refreshes while a choice is waiting: nothing she chose is erased", async () => {
    const { browser } = await professionalWithVisit("Tia", "Rose");
    const { page } = await open(browser);
    // The first save's answer sets a cookie, so the route refreshes: its
    // layout brings the account without her second choice, which is held.
    const second = await hold(
      page,
      (route) => isSave(route) && actionBody(route).includes('"motion"'),
    );
    await choose(page, /^Sombre/);
    await choose(page, /^Aucune/);
    await second.here;
    await said(page, "Enregistrement…");
    expect(await page.getByRole("radio", { name: /^Aucune/ }).isChecked()).toBe(
      true,
    );
    expect(await page.getByRole("radio", { name: /^Sombre/ }).isChecked()).toBe(
      true,
    );

    await second.release();
    await said(page, SAVED);
    expect(await rowOf(browser)).toMatchObject({
      color_mode: "dark",
      motion: "none",
    });
    await page.context().close();
  });

  it("she navigates while a save is held; Next.js forgets it, the timeout does not", async () => {
    const { browser } = await professionalWithVisit("Uma", "Rose");
    const { page } = await open(browser);
    await page.clock.install();
    const save = await hold(page, isSave);
    await choose(page, /^Sombre/);
    await save.here;
    await page.getByRole("link", { name: "Agenda" }).first().click();
    await page.waitForURL(`${APP}/app`);

    await page.clock.fastForward(16_000);
    await save.release();
    await page.clock.fastForward(2_000);
    await inDatabase(browser, { color_mode: "dark" });
    await page.context().close();
  });

  it("a read stuck past its timeout blocks nothing she does next", async () => {
    const { browser } = await professionalWithVisit("Vea", "Rose");
    const { page } = await open(browser);
    await page.clock.install();
    const read = await hold(page, isRead);
    await comeBack(page);
    await read.here;
    await page.clock.fastForward(16_000);
    await choose(page, /^Aucune/);
    await read.release();
    await inDatabase(browser, { motion: "none" });
    await page.context().close();
  });
});

describe("another session under the page", () => {
  const signIn = async (page: Page, browser: Browser) => {
    await page.context().clearCookies();
    await page.context().addCookies(
      [...browser.cookies].map(([name, value]) => ({
        name,
        value,
        url: APP,
      })),
    );
  };

  it("another account, with a choice not sent yet: never written to it", async () => {
    const mine = await professionalWithVisit("Wen", "Rose");
    const theirs = await professionalWithVisit("Xia", "Rose");
    await db.query(
      `insert into public.member_preferences (business_id, user_id, style)
       values ($1, $2, 'studio')`,
      [theirs.browser.member!.businessId, theirs.browser.member!.userId],
    );
    const { page } = await open(mine.browser);

    await signIn(page, theirs.browser);
    await choose(page, /^Écrin/);

    // The server refused for this page's context; the layout gave the new one.
    await drawn(page, "studio");
    expect(await rowOf(theirs.browser)).toMatchObject({
      style: "studio",
      version: "1",
    });
    expect(await rowOf(mine.browser)).toBeNull();
    await page.context().close();
  });

  it("signs out, signs in again: nothing readable between, the same look after", async () => {
    const { browser } = await professionalWithVisit("Yua", "Rose");
    const { page } = await open(browser);
    await choose(page, /^Studio/);
    await said(page, SAVED);

    const signedIn = await page.context().cookies();
    await page.context().clearCookies();
    await page.goto(`${APP}/app`);
    expect(new URL(page.url()).pathname).toBe("/login");

    await page.context().addCookies(signedIn);
    await page.goto(`${APP}/app`);
    await drawn(page, "studio");
    await page.context().close();
  });

  it("removed from the business, then back: the old page writes nothing, the new one starts anew", async () => {
    const { browser } = await professionalWithVisit("Zoe", "Rose");
    const { userId, businessId } = browser.member!;
    const { page } = await open(browser);
    await choose(page, /^Studio/);
    await said(page, SAVED);

    await db.query(
      "delete from public.business_members where business_id = $1 and user_id = $2",
      [businessId, userId],
    );
    expect(await rowOf(browser)).toBeNull();
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')",
      [businessId, userId],
    );

    // The tab left open still names the old membership: refused, then the
    // layout gives the new one, and the choice of the old one is dropped.
    await choose(page, /^Sombre/);
    await drawn(page, "classique");
    expect(await rowOf(browser)).toBeNull();

    await choose(page, /^Écrin/);
    await said(page, SAVED);
    expect(await rowOf(browser)).toMatchObject({
      style: "ecrin",
      version: "1",
      color_mode: "light",
    });
    await page.context().close();
  });
});

describe("the look an old version left on this device", () => {
  const offered = async (name: string, appearance: string | null = null) => {
    const { browser } = await professionalWithVisit(name, "Rose");
    const { page } = await signedInPage(browser, {
      appearance,
      legacyCookie: look("ecrin", "dark"),
    });
    await page.goto(`${APP}/app`);
    await hydrated(page.getByRole("button", { name: /Rose Visite/ }).first());
    return { browser, page };
  };
  const question = (page: Page) =>
    page.getByRole("region", {
      name: "Garder cette apparence sur votre compte ?",
    });
  const deviceCookie = async (page: Page) =>
    (await page.context().cookies()).some(
      ({ name }) => name === "dash_appearance",
    );

  it("is only asked about, then kept when she says so", async () => {
    const { browser, page } = await offered("Ada");
    await question(page).waitFor();
    expect((await applied(page)).style).toBe("classique");
    expect(await rowOf(browser)).toBeNull();
    await expectAccessible(page, "the question");

    await question(page).getByRole("button", { name: "Garder" }).click();
    await inDatabase(browser, { style: "ecrin", color_mode: "dark" });
    await drawn(page, "ecrin");
    await question(page).waitFor({ state: "detached" });
    expect(await deviceCookie(page)).toBe(false);

    await page.reload();
    await drawn(page, "ecrin");
    expect(await question(page).count()).toBe(0);
    await page.context().close();
  });

  it("declined: nothing written, and not asked again", async () => {
    const { browser, page } = await offered("Bea");
    await question(page).getByRole("button", { name: "Non merci" }).click();
    await question(page).waitFor({ state: "detached" });
    expect(await deviceCookie(page)).toBe(false);
    expect(await rowOf(browser)).toBeNull();

    await page.reload();
    await hydrated(page.getByRole("button", { name: /Rose Visite/ }).first());
    expect(await question(page).count()).toBe(0);
    await drawn(page, "classique");
    await page.context().close();
  });

  it("an account with its own look: not asked, and untouched", async () => {
    const { browser, page } = await offered("Cleo", look("studio"));
    expect(await question(page).count()).toBe(0);
    await drawn(page, "studio");
    expect(await rowOf(browser)).toMatchObject({ style: "studio" });
    await page.context().close();
  });
});

describe.each(["classique", "studio", "ecrin"])(
  "the settings — %s",
  (style) => {
    it.each([
      { width: 1440, phone: false },
      { width: 390, phone: true },
      { width: 320, phone: true },
    ])(
      "$width px: accessible, no side scroll, by the frame's own way there",
      async ({ width, phone }) => {
        const { browser } = await professionalWithVisit("Dana", "Rose");
        const { page } = await signedInPage(browser, {
          appearance: look(style),
          width,
          height: 800,
          phone,
        });
        await page.goto(SETTINGS);
        await hydrated(page.getByRole("radio", { name: /^Studio/ }));
        await drawn(page, style);
        expect(await noSideScroll(page)).toBe(true);
        await expectAccessible(page, `settings ${style} ${width}`);
        await page.context().close();
      },
      60_000,
    );
  },
);
