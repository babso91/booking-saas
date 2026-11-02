import type { Page, Request, Route } from "playwright";
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
const said = (page: Page, text: string | RegExp) =>
  page.getByRole("status").filter({ hasText: text }).first().waitFor();
// Exactly: a string matches anywhere, whatever the case, and "Pas encore
// enregistré sur ton compte" would pass for it.
const SAVED = /^Enregistré sur ton compte\.$/;

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

/**
 * Holds the first request matching, until the test lets it go. The route stays
 * installed: removing the last one continues what it holds, whatever the test
 * says next (Playwright's removeHandler).
 */
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
    release: () => held!.continue(),
    /** It never reached the server. */
    lose: () => held!.abort(),
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
    expect(await rowOf(browser)).toBeNull();

    // The first one is still held: only the driver's new attempt can write.
    await page.clock.fastForward(16_000);
    await page.clock.fastForward(2_000);
    await inDatabase(browser, { color_mode: "dark" });
    await save.lose();
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

describe("a session that is gone", () => {
  it("expired under the page: she stays, her choice stays, and it arrives once back", async () => {
    const { browser } = await professionalWithVisit("Ines", "Rose");
    const { page } = await open(browser);
    const signedIn = await page.context().cookies();
    await page.context().clearCookies();

    await choose(page, /^Sombre/);
    await said(page, /Pas encore enregistré|en pause/);
    expect(new URL(page.url()).pathname).toBe("/app/settings/appearance");
    expect(await rowOf(browser)).toBeNull();
    expect(await page.getByRole("radio", { name: /^Sombre/ }).isChecked()).toBe(
      true,
    );
    await page.getByRole("link", { name: "Me reconnecter" }).waitFor();

    await page.context().addCookies(signedIn);
    await page.getByRole("button", { name: "Réessayer" }).click();
    await inDatabase(browser, { color_mode: "dark" });
    await said(page, SAVED);
    expect(new URL(page.url()).pathname).toBe("/app/settings/appearance");
    await page.context().close();
  });
});

describe("a style chosen on another device", () => {
  const elsewhere = async (
    browser: Browser,
    name: RegExp,
    row: Partial<Row>,
  ) => {
    const other = await signedInPage(browser, { appearance: null });
    await openSettings(other.page);
    await choose(other.page, name);
    await inDatabase(browser, row);
    await other.page.context().close();
  };

  it("does not touch the form she is filling in, then the next page is in it", async () => {
    const { browser } = await professionalWithVisit("Jade", "Rose");
    const { page } = await signedInPage(browser, {
      appearance: look("studio"),
    });
    await page.goto(`${APP}/app/services`);
    await drawn(page, "studio");
    await (
      await hydrated(
        page.getByRole("button", { name: "Ajouter une prestation" }).first(),
      )
    ).click();
    const name = page.getByLabel("Nom", { exact: true });
    await name.fill("Soin du re");
    await name.evaluate((input) => {
      (window as unknown as { draft: Element }).draft = input;
    });

    await elsewhere(browser, /^Écrin/, { style: "ecrin" });
    await comeBack(page);
    await said(page, "Ton compte est passé à Écrin");

    // The read's answer refreshed the route: the same element, still there.
    expect(await name.inputValue()).toBe("Soin du re");
    expect(
      await name.evaluate(
        (input) =>
          (window as unknown as { draft: Element }).draft === input &&
          input.isConnected,
      ),
    ).toBe(true);
    expect((await applied(page)).style).toBe("studio");

    // She finishes, and what she typed is what is created.
    await name.pressSequentially("gard");
    await page.getByLabel("Durée", { exact: true }).fill("45");
    await page.getByLabel("Prix", { exact: true }).fill("50");
    await page
      .getByRole("button", { name: "Enregistrer", exact: true })
      .click();
    await vi.waitFor(
      async () => {
        const { rows } = await db.query(
          "select 1 from public.services where business_id = $1 and name = $2",
          [browser.member!.businessId, "Soin du regard"],
        );
        expect(rows).toHaveLength(1);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect((await applied(page)).style).toBe("studio");

    await page
      .getByRole("link", { name: /Agenda/ })
      .filter({ visible: true })
      .first()
      .click();
    await page.waitForURL(`${APP}/app`);
    await drawn(page, "ecrin");
    await page.context().close();
  });

  it("is applied when she asks; the card is accessible", async () => {
    const { browser } = await professionalWithVisit("Kim", "Rose");
    const { page } = await open(browser);
    await elsewhere(browser, /^Studio/, { style: "studio" });
    await comeBack(page);
    await said(page, "Ton compte est passé à Studio");
    expect((await applied(page)).style).toBe("classique");
    await expectAccessible(page, "the card of a received style");

    await page.getByRole("button", { name: "Appliquer maintenant" }).click();
    await drawn(page, "studio");
    await page.context().close();
  });
});

type SaveOnWire = {
  membershipId: string;
  changes: Record<string, unknown>;
  answer: string;
};

// The page keeps its own copy of the answer, read as it arrives. Asking the
// browser for the body afterwards (response.text()) is not reliable: once the
// page gave the stream up, Chromium has "No data found", no navigation needed.
const COPY_THE_ANSWERS = `{
  const send = window.fetch;
  window.fetch = async (input, init) => {
    const response = await send(input, init);
    const body = init && init.body;
    if (typeof body === "string" && body.includes('"changes"')) {
      response.clone().text().then(
        (text) => window.__saveAnswered(body, text),
        (error) => window.__saveAnswered(body, "unreadable: " + error),
      );
    }
    return response;
  };
}`;

/** Only the action's own row: the rest of the answer is the page's render. */
const resultOf = (text: string) => {
  const row = /"a":"\$@(\w+)"/.exec(text)?.[1];
  const result = text
    .split("\n")
    .find((line) => row !== undefined && line.startsWith(`${row}:`));
  return (
    /"code":"(\w+)"/.exec(result ?? "")?.[1] ??
    /"status":"(\w+)"/.exec(result ?? "")?.[1] ??
    `unreadable: ${text.slice(0, 200)}`
  );
};

/**
 * Loads the page again with a witness: every save it sends from then on, for
 * whom, what (as it leaves, from the request), and what the server said; and
 * how many documents were loaded since, to tell a navigation from a render.
 * Nothing here can reject behind the test's back: an answer that never comes
 * fails `saves()`, and a closed page takes its listeners and its copies along.
 */
async function savesOnWire(page: Page) {
  const seen: { body: string; answer: string | null }[] = [];
  let documents = -1;
  const onRequest = (request: Request) => {
    const body = request.postData() ?? "";
    if (request.headers()["next-action"] && body.includes('"changes"')) {
      seen.push({ body, answer: null });
    }
  };
  const onDocument = () => {
    documents += 1;
  };
  page.on("request", onRequest);
  page.on("domcontentloaded", onDocument);
  page.once("close", () => {
    page.off("request", onRequest);
    page.off("domcontentloaded", onDocument);
  });
  await page.exposeFunction("__saveAnswered", (body: string, text: string) => {
    const save = seen.find((s) => s.body === body && s.answer === null);
    // Never seen leaving: kept, so that the comparison shows it.
    if (save) save.answer = text;
    else seen.push({ body, answer: `not on the wire: ${text}` });
  });
  await page.addInitScript({ content: COPY_THE_ANSWERS });
  await openSettings(page);
  return {
    saves: async (): Promise<SaveOnWire[]> => {
      await vi.waitFor(
        () => expect(seen.filter(({ answer }) => answer === null)).toEqual([]),
        { timeout: 15_000, interval: 50 },
      );
      return seen.map(({ body, answer }) => {
        const [{ context, changes }] = JSON.parse(body);
        return {
          membershipId: context.membershipId,
          changes,
          answer: resultOf(answer!),
        };
      });
    },
    documentsLoaded: () => documents,
  };
}

describe("removed from the business, then back: what the wire and the database say", () => {
  const memberOf = async ({ member }: Browser) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.business_members where business_id = $1 and user_id = $2",
      [member!.businessId, member!.userId],
    );
    return rows[0]!.id;
  };
  const removedAndBack = async (browser: Browser) => {
    const { userId, businessId } = browser.member!;
    await db.query(
      "delete from public.business_members where business_id = $1 and user_id = $2",
      [businessId, userId],
    );
    expect(await rowOf(browser)).toBeNull();
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')",
      [businessId, userId],
    );
    return memberOf(browser);
  };
  /** Her account in Studio, on a page where nothing is on its way any more. */
  const settled = async (name: string) => {
    const { browser } = await professionalWithVisit(name, "Rose");
    const { page } = await open(browser);
    await choose(page, /^Studio/);
    await said(page, SAVED);
    const wire = await savesOnWire(page);
    await drawn(page, "studio");
    return { browser, page, wire, before: await memberOf(browser) };
  };

  it("a choice born under the old one is refused, dropped, and never written to the new one", async () => {
    const { browser, page, wire, before } = await settled("Lou");
    const after = await removedAndBack(browser);
    expect(after).not.toBe(before);

    await choose(page, /^Sombre/);
    await drawn(page, "classique");
    expect(await page.getByRole("radio", { name: /^Clair/ }).isChecked()).toBe(
      true,
    );
    expect(await rowOf(browser)).toBeNull();

    await choose(page, /^Écrin/);
    await inDatabase(browser, { style: "ecrin" });
    await said(page, SAVED);
    expect(await wire.saves()).toEqual([
      {
        membershipId: before,
        changes: { mode: "dark" },
        answer: "context_changed",
      },
      { membershipId: after, changes: { style: "ecrin" }, answer: "saved" },
    ]);
    expect(await rowOf(browser)).toMatchObject({
      style: "ecrin",
      version: "1",
      color_mode: "light",
    });
    expect(wire.documentsLoaded()).toBe(0);
    await page.context().close();
  });

  it("a choice made once the new one is drawn is hers: written to it (dark, then Écrin, version 2)", async () => {
    const { browser, page, wire } = await settled("Mia");
    const after = await removedAndBack(browser);
    await comeBack(page);
    await drawn(page, "classique");
    expect(await rowOf(browser)).toBeNull();

    await choose(page, /^Sombre/);
    await inDatabase(browser, { color_mode: "dark", version: "1" });
    await choose(page, /^Écrin/);
    await inDatabase(browser, {
      style: "ecrin",
      color_mode: "dark",
      version: "2",
    });
    expect(await wire.saves()).toEqual([
      { membershipId: after, changes: { mode: "dark" }, answer: "saved" },
      { membershipId: after, changes: { style: "ecrin" }, answer: "saved" },
    ]);
    expect(wire.documentsLoaded()).toBe(0);
    await page.context().close();
  });

  it("without waiting for anything: whichever side the click falls on, only the new side is written", async () => {
    const { browser } = await professionalWithVisit("Zoe", "Rose");
    const { page } = await open(browser);
    const before = await memberOf(browser);
    const wire = await savesOnWire(page);
    await choose(page, /^Studio/);
    await said(page, SAVED);
    const after = await removedAndBack(browser);

    await choose(page, /^Sombre/);
    await drawn(page, "classique");
    await choose(page, /^Écrin/);
    await inDatabase(browser, { style: "ecrin" });

    const [, sombre] = await wire.saves();
    const oldSide = sombre!.membershipId === before;
    console.info(
      `[membership trace] Sombre sent to the ${oldSide ? "old" : "new"} one, answered ${sombre!.answer}`,
    );
    expect(await wire.saves()).toEqual([
      { membershipId: before, changes: { style: "studio" }, answer: "saved" },
      {
        membershipId: oldSide ? before : after,
        changes: { mode: "dark" },
        answer: oldSide ? "context_changed" : "saved",
      },
      { membershipId: after, changes: { style: "ecrin" }, answer: "saved" },
    ]);
    await inDatabase(
      browser,
      oldSide
        ? { style: "ecrin", version: "1", color_mode: "light" }
        : { style: "ecrin", version: "2", color_mode: "dark" },
    );
    expect(wire.documentsLoaded()).toBe(0);
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
      name: "Garder cette apparence sur ton compte ?",
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
