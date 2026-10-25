import { randomUUID } from "node:crypto";

import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
} from "../integration/support/fixtures";
import {
  call,
  launchBrowser,
  newProfile,
  newestSession,
  prepareSignIn,
  sessionCookies,
  signIn,
} from "./support/browser";
import { EVIL_URL, HUB_HOST, startIngress } from "./support/hub-ingress";

// The Client Hub's sessions in real Chromium, against the production build
// behind its TLS ingress (support/hub-ingress.ts), with real PostgreSQL.
// The browser stores, sends and deletes the cookies from the responses'
// real Set-Cookie headers; the test only decides WHEN a response reaches
// the browser (held after the server processed it, delivered late, lost,
// or never delivered because its tab was closed). Several tabs of one
// profile share one cookie jar, as in a real browser.
//
// The first two tests are the two defects found on the shared cookie
// (a late sign-out erased a newer session; a late sign-in put an older
// identity back in another tab): written against the browser's behaviour
// only, they fail on the former protocol.

const { mailpitUrl, hubOriginUrl, hubProxySecret } = inject("e2e");
const ME = "/api/client-hub/me";
const SESSION = "/api/client-hub/session";
const VERIFY = "/api/client-hub/session/verify";

const address = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}@client.test`;

let browser: Browser;
let ingress: Awaited<ReturnType<typeof startIngress>>;
const opened: BrowserContext[] = [];

beforeAll(async () => {
  ingress = await startIngress(hubProxySecret);
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await ingress?.stop();
});

/**
 * Holds the answer to the next `method path` at the ingress, once the
 * server has processed the request (the tab is irrelevant: the network
 * path is the browser's).
 */
const holdNext = async (_tab: Page, method: string, path: string) =>
  ingress.holdNext(method, path);

/** A browser profile with `count` tabs on the hub's sign-in page. */
async function profileWithTabs(
  count: number,
  options: { broadcastChannel?: boolean } = {},
) {
  const context = await newProfile(browser, options);
  opened.push(context);
  const tabs: Page[] = [];
  for (let i = 0; i < count; i += 1) {
    const tab = await context.newPage();
    await tab.goto("/espace/connexion");
    tabs.push(tab);
  }
  return { context, tabs };
}

async function accountSessions(email: string) {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from private.client_hub_sessions s
     join private.client_hub_accounts a on a.id = s.account_id
     where a.email = $1 and s.revoked_at is null and s.expires_at > now()`,
    [email],
  );
  return rows[0]!.n;
}

describe("the two defects of the shared cookie (fail on the former protocol)", () => {
  it("defect 1: A's sign-out, answered after B signed in, never signs B out", async () => {
    const { tabs } = await profileWithTabs(2);
    const [tabA, tabB] = tabs as [Page, Page];
    const a = address("d1-a");
    const b = address("d1-b");
    await signIn(tabA, mailpitUrl, a);
    const held = await holdNext(tabA, "DELETE", SESSION);
    const out = call(tabA, "DELETE", SESSION);
    await held.processed;
    await signIn(tabB, mailpitUrl, b);
    expect((await call(tabB, "GET", ME)).body?.data?.email).toBe(b);
    held.release();
    expect((await out).status).toBe(200);
    const after = await call(tabB, "GET", ME);
    expect(after.status).toBe(200);
    expect(after.body?.data?.email).toBe(b);
  });

  it("defect 2: A's sign-in, answered after B signed in, never shows A in B's tab", async () => {
    const { tabs } = await profileWithTabs(2);
    const [tabA, tabB] = tabs as [Page, Page];
    const a = address("d2-a");
    const b = address("d2-b");
    const verifyA = await prepareSignIn(tabA, mailpitUrl, a);
    const held = await holdNext(tabA, "POST", VERIFY);
    const verifying = verifyA();
    await held.processed;
    await signIn(tabB, mailpitUrl, b);
    expect((await call(tabB, "GET", ME)).body?.data?.email).toBe(b);
    held.release();
    expect((await verifying).status).toBe(200);
    const after = await call(tabB, "GET", ME);
    expect(JSON.stringify(after.body)).not.toContain(a);
    // Two accounts' sessions crossed in one browser: no identity is chosen.
    expect(after.status).toBe(401);
    expect(after.body?.error?.code).toBe("client_hub_unauthenticated");
  });
});

describe("answers arriving in every order, several tabs", () => {
  it("concurrent sign-ins of two accounts, answers in both orders: nobody is chosen, both sessions end, the browser signs in again normally", async () => {
    for (const first of ["A", "B"] as const) {
      const { context, tabs } = await profileWithTabs(3);
      const [tabA, tabB, tabC] = tabs as [Page, Page, Page];
      const a = address("both-a");
      const b = address("both-b");
      const verifyA = await prepareSignIn(tabA, mailpitUrl, a);
      const verifyB = await prepareSignIn(tabB, mailpitUrl, b);
      const heldA = await holdNext(tabA, "POST", VERIFY);
      const doneA = verifyA();
      await heldA.processed;
      const heldB = await holdNext(tabB, "POST", VERIFY);
      const doneB = verifyB();
      await heldB.processed;
      const [x, y] = first === "A" ? [heldA, heldB] : [heldB, heldA];
      x.release();
      await (first === "A" ? doneA : doneB);
      y.release();
      await Promise.all([doneA, doneB]);
      expect((await sessionCookies(context)).length).toBe(2);

      const now = await call(tabC, "GET", ME);
      expect(now.status, first).toBe(401);
      expect(await accountSessions(a)).toBe(0);
      expect(await accountSessions(b)).toBe(0);
      // Its answer deleted both cookies, in Chromium.
      expect(await sessionCookies(context)).toEqual([]);
      await signIn(tabC, mailpitUrl, b);
      expect((await call(tabA, "GET", ME)).body?.data?.email).toBe(b);
    }
  });

  it("two sign-ins of one account crossing: the most recent session is kept whatever order the answers arrive in", async () => {
    for (const lastDelivered of ["older", "newer"] as const) {
      const { context, tabs } = await profileWithTabs(2);
      const [tab1, tab2] = tabs as [Page, Page];
      const who = address("same");
      const verifyOld = await prepareSignIn(tab1, mailpitUrl, who);
      const heldOld = await holdNext(tab1, "POST", VERIFY);
      const doneOld = verifyOld();
      await heldOld.processed;
      const verifyNew = await prepareSignIn(tab2, mailpitUrl, who);
      const heldNew = await holdNext(tab2, "POST", VERIFY);
      const doneNew = verifyNew();
      await heldNew.processed;
      if (lastDelivered === "older") {
        heldNew.release();
        await doneNew;
        heldOld.release();
      } else {
        heldOld.release();
        await doneOld;
        heldNew.release();
      }
      await Promise.all([doneOld, doneNew]);
      const now = await call(tab1, "GET", ME);
      expect(now.body?.data?.email, lastDelivered).toBe(who);
      expect(await accountSessions(who)).toBe(1);
      expect((await sessionCookies(context)).length).toBe(1);
    }
  });

  it("A's sign-out and B's sign-in both held, delivered in both orders: B stays signed in", async () => {
    for (const first of ["sign-out", "sign-in"] as const) {
      const { tabs } = await profileWithTabs(3);
      const [tabA, tabB, tabC] = tabs as [Page, Page, Page];
      const a = address("out-in-a");
      const b = address("out-in-b");
      await signIn(tabA, mailpitUrl, a);
      const verifyB = await prepareSignIn(tabB, mailpitUrl, b);
      const heldOut = await holdNext(tabA, "DELETE", SESSION);
      const heldIn = await holdNext(tabB, "POST", VERIFY);
      const out = call(tabA, "DELETE", SESSION);
      await heldOut.processed;
      const signingIn = verifyB();
      await heldIn.processed;
      if (first === "sign-out") {
        heldOut.release();
        await out;
        heldIn.release();
      } else {
        heldIn.release();
        await signingIn;
        heldOut.release();
      }
      await Promise.all([out, signingIn]);
      const now = await call(tabC, "GET", ME);
      expect(now.status, first).toBe(200);
      expect(now.body?.data?.email).toBe(b);
    }
  });

  it("A → B → A: answers served for each identity name it; a late one never brings the previous identity back", async () => {
    const { tabs } = await profileWithTabs(2);
    const [tab1, tab2] = tabs as [Page, Page];
    const a = address("aba-a");
    const b = address("aba-b");
    await signIn(tab1, mailpitUrl, a);
    const asA = await call(tab1, "GET", ME);
    // A read of A is processed now and delivered late.
    const heldRead = await holdNext(tab1, "GET", ME);
    const lateRead = call(tab1, "GET", ME);
    await heldRead.processed;
    await signIn(tab2, mailpitUrl, b);
    const asB = await call(tab2, "GET", ME);
    await signIn(tab2, mailpitUrl, a);
    const asA2 = await call(tab2, "GET", ME);
    heldRead.release();
    const late = await lateRead;
    expect(late.account).toBe(asA.account);
    expect(asB.account).not.toBe(asA.account);
    expect(asA2.account).toBe(asA.account);
    // The late read deleted nothing: A (again) is still signed in.
    expect((await call(tab1, "GET", ME)).body?.data?.email).toBe(a);
  });
});

describe("tabs closed, connections lost, waits abandoned", () => {
  it("a tab closed while its sign-in is processed, B signing in meanwhile: whether Chromium applies that answer or not, B's tab never shows A", async () => {
    const { context, tabs } = await profileWithTabs(2);
    const [tabA, tabB] = tabs as [Page, Page];
    const a = address("closed-in-a");
    const b = address("closed-in-b");
    const verifyA = await prepareSignIn(tabA, mailpitUrl, a);
    const held = await holdNext(tabA, "POST", VERIFY);
    void verifyA().catch(() => undefined);
    await held.processed;
    await tabA.close();
    await signIn(tabB, mailpitUrl, b);
    // The closed tab's answer reaches the network now (Chromium may still
    // apply its Set-Cookie, or not: both are safe).
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const now = await call(tabB, "GET", ME);
    expect(JSON.stringify(now.body)).not.toContain(a);
    expect([200, 401]).toContain(now.status);
    if (now.status === 200) {
      expect(now.body?.data?.email).toBe(b);
      expect((await sessionCookies(context)).length).toBe(1);
    } else {
      // Applied: two accounts crossed, both ended, no cookie left.
      expect(await accountSessions(b)).toBe(0);
      expect(await sessionCookies(context)).toEqual([]);
    }
  });

  it("a tab closed while its sign-out is processed: the session is over either way; no cookie survives the next read", async () => {
    const { context, tabs } = await profileWithTabs(2);
    const [tabA, tabB] = tabs as [Page, Page];
    const a = address("closed-out");
    await signIn(tabA, mailpitUrl, a);
    const held = await holdNext(tabA, "DELETE", SESSION);
    void call(tabA, "DELETE", SESSION).catch(() => undefined);
    await held.processed;
    await tabA.close();
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Chromium applied the deletion or not; the session is over anyway, and
    // the next read from any tab deletes a cookie still there.
    expect(await accountSessions(a)).toBe(0);
    expect((await call(tabB, "GET", ME)).status).toBe(401);
    expect(await sessionCookies(context)).toEqual([]);
  });

  it("a sign-in whose answer is lost after the server processed it: no cookie; another sign-in works", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const [tab] = tabs as [Page];
    const a = address("lost");
    const verifyA = await prepareSignIn(tab, mailpitUrl, a);
    const held = await holdNext(tab, "POST", VERIFY);
    const verifying = verifyA();
    await held.processed;
    held.lose();
    // No answer reaches the page: a network error, or (Chromium retries a
    // request whose reused connection was cut) the retry, refused because
    // the code was single use. Either way, no cookie and no session for
    // this browser.
    expect([0, 400]).toContain((await verifying).status);
    expect(await sessionCookies(context)).toEqual([]);
    expect((await call(tab, "GET", ME)).status).toBe(401);
    await signIn(tab, mailpitUrl, a);
    expect((await call(tab, "GET", ME)).body?.data?.email).toBe(a);
  });

  it("a wait abandoned by the page (timeout) before the answer arrives: its cookie is never applied", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const [tab] = tabs as [Page];
    const a = address("abandoned");
    const asked = await call(tab, "POST", "/api/client-hub/session/code", {
      email: a,
    });
    const { codeFor } = await import("./support/browser");
    const code = await codeFor(mailpitUrl, a);
    const held = await holdNext(tab, "POST", VERIFY);
    const abandoned = tab.evaluate(
      async ([challengeId, email, code]) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        try {
          await fetch("/api/client-hub/session/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ challengeId, email, code }),
            signal: controller.signal,
          });
          return "answered";
        } catch {
          return "abandoned";
        }
      },
      [asked.body!.data!.challengeId as string, a, code] as const,
    );
    await held.processed;
    expect(await abandoned).toBe("abandoned");
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await sessionCookies(context)).toEqual([]);
  });

  it("offline during a read: no answer, cookies untouched; back online, the same session", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const [tab] = tabs as [Page];
    const a = address("offline");
    await signIn(tab, mailpitUrl, a);
    const before = await sessionCookies(context);
    await context.setOffline(true);
    expect((await call(tab, "GET", ME)).status).toBe(0);
    await context.setOffline(false);
    expect(await sessionCookies(context)).toEqual(before);
    expect((await call(tab, "GET", ME)).body?.data?.email).toBe(a);
  });
});

describe("revocation, expiry, signing out everywhere", () => {
  it("signed out everywhere from another device: refused here, and the dead cookie is deleted by Chromium", async () => {
    const here = await profileWithTabs(1);
    const there = await profileWithTabs(1);
    const a = address("everywhere");
    await signIn(here.tabs[0]!, mailpitUrl, a);
    await signIn(there.tabs[0]!, mailpitUrl, a);
    expect(
      (await call(there.tabs[0]!, "DELETE", `${SESSION}?all=true`)).status,
    ).toBe(200);
    expect(await sessionCookies(there.context)).toEqual([]);
    expect((await call(here.tabs[0]!, "GET", ME)).status).toBe(401);
    expect(await sessionCookies(here.context)).toEqual([]);
  });

  it("expired: refused, its cookie deleted, nothing else touched", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const a = address("expired");
    await signIn(tabs[0]!, mailpitUrl, a);
    const [cookie] = await sessionCookies(context);
    await db.query(
      `update private.client_hub_sessions set expires_at = now() - interval '1 second' where id = $1`,
      [cookie!.session],
    );
    expect((await call(tabs[0]!, "GET", ME)).status).toBe(401);
    expect(await sessionCookies(context)).toEqual([]);
  });
});

describe("the cookies as Chromium stores and sends them", () => {
  it("one __Host- cookie per session (HttpOnly, Secure, SameSite=Lax, Path=/, host-only), unreadable by scripts; pages receive it but render nothing from it", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const [tab] = tabs as [Page];
    const before = (await sessionCookies(context)).map((c) => c.session);
    const who = address("attributes");
    await signIn(tab, mailpitUrl, who);
    const [added] = await newestSession(context, before);
    expect(await sessionCookies(context)).toEqual([
      {
        session: added,
        domain: HUB_HOST,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    expect((await context.cookies()).map((c) => c.name)).toEqual([
      `__Host-client_hub_s_${added}`,
    ]);
    expect(await tab.evaluate(() => document.cookie)).not.toContain(
      "client_hub",
    );
    // Path=/ sends it to the pages too: their server render shows nothing
    // of her (the pages are shells; every read goes through the API).
    let sentToPage: string | undefined;
    tab.on("request", (request) => {
      if (request.url().endsWith("/espace"))
        void request.allHeaders().then((h) => (sentToPage = h.cookie));
    });
    const page = await tab.goto("/espace");
    expect(sentToPage ?? "").toContain(`__Host-client_hub_s_${added}=`);
    const html = await page!.text();
    expect(html).not.toContain(who);
    expect(html).not.toMatch(/Bonjour [A-Z]|Solde :/);
  });
});

describe("a hostile sibling subdomain (real Domain=hub.test cookies from https://evil.hub.test)", () => {
  /**
   * Plants `name=value` from https://evil.hub.test for every *.hub.test,
   * in every form a sibling can try: on the whole host and on the hub's
   * API path. Returns what Chromium accepted.
   */
  async function plant(context: BrowserContext, name: string, value: string) {
    const evil = await context.newPage();
    await evil.goto(`${EVIL_URL}/api/health`);
    await evil.evaluate(
      ([name, value]) => {
        for (const path of ["/", "/api/client-hub"]) {
          document.cookie = `${name}=${value}; Domain=hub.test; Path=${path}; Secure; SameSite=Lax`;
        }
      },
      [name, value] as const,
    );
    await evil.close();
  }

  /**
   * Plants a session cookie (its id and value) under every name a sibling
   * could hope the hub reads: the session's bare name, its prefixed name
   * (refused by the browser with Domain=), a lowercase prefix, and a
   * nameless cookie whose value spells the prefixed name.
   */
  async function plantSession(
    context: BrowserContext,
    session: string,
    value: string,
  ) {
    const evil = await context.newPage();
    await evil.goto(`${EVIL_URL}/api/health`);
    await evil.evaluate(
      ([session, value]) => {
        const forms = [
          `client_hub_s_${session}=${value}`,
          `__Host-client_hub_s_${session}=${value}`,
          `__host-client_hub_s_${session}=${value}`,
          `__Secure-client_hub_s_${session}=${value}`,
          `=__Host-client_hub_s_${session}=${value}`,
        ];
        for (const form of forms) {
          for (const path of ["/", "/api/client-hub"]) {
            document.cookie = `${form}; Domain=hub.test; Path=${path}; Secure; SameSite=Lax`;
          }
        }
        // Without Domain, from the sibling: its own host only.
        document.cookie = `__Host-client_hub_s_${session}=${value}; Path=/; Secure; SameSite=Lax`;
      },
      [session, value] as const,
    );
    await evil.close();
  }

  async function attackerSession() {
    const { context, tabs } = await profileWithTabs(1);
    const who = address("attacker");
    await signIn(tabs[0]!, mailpitUrl, who);
    const [cookie] = await context.cookies();
    return {
      who,
      session: cookie!.name.replace(/^(__Host-)?client_hub_s_/, ""),
      value: cookie!.value,
    };
  }

  it("the browser never lets a sibling set a __Host- cookie for the hub: neither with Domain=, nor nameless, nor on its own host", async () => {
    const attacker = await attackerSession();
    const { context } = await profileWithTabs(1);
    await plantSession(context, attacker.session, attacker.value);
    const planted = await context.cookies();
    // The bare names are accepted (Domain=hub.test): the hub must ignore them.
    expect(
      planted.some((c) => c.name === `client_hub_s_${attacker.session}`),
    ).toBe(true);
    // Nothing that reaches app.hub.test carries the __Host- prefix, in any
    // spelling, as a name or as a nameless cookie's value. (__Secure- does
    // allow Domain=: the hub does not read that prefix.)
    const reachingHub = planted.filter(
      (c) => c.domain === ".hub.test" || c.domain === HUB_HOST,
    );
    expect(reachingHub.length).toBeGreaterThan(0);
    for (const cookie of reachingHub) {
      expect(cookie.name, cookie.name).not.toMatch(/^__host-/i);
      expect(cookie.value, cookie.name).not.toMatch(/^__host-/i);
    }
  });

  it("IMPORTANT 1 (forced sign-in): a browser without a session of its own never accepts the attacker's planted live session", async () => {
    const attacker = await attackerSession();
    const { context, tabs } = await profileWithTabs(1);
    await plantSession(context, attacker.session, attacker.value);
    const now = await call(tabs[0]!, "GET", ME);
    expect(JSON.stringify(now.body)).not.toContain(attacker.who);
    expect(now.status).toBe(401);
    // The pages show the sign-in, never the attacker.
    await tabs[0]!.goto("/espace");
    await tabs[0]!.waitForURL(/\/espace\/connexion/);
    expect(await tabs[0]!.getByText(attacker.who).count()).toBe(0);
  });

  it("the attacker's session planted next to the victim's: ignored; the victim stays herself and neither session is touched", async () => {
    const attacker = await attackerSession();
    const { context, tabs } = await profileWithTabs(1);
    const victim = address("victim");
    await signIn(tabs[0]!, mailpitUrl, victim);
    await plantSession(context, attacker.session, attacker.value);
    const now = await call(tabs[0]!, "GET", ME);
    expect(now.status).toBe(200);
    expect(now.body?.data?.email).toBe(victim);
    expect(await accountSessions(victim)).toBe(1);
    expect(await accountSessions(attacker.who)).toBe(1);
  });

  it("IMPORTANT 2 (persistent lockout): seventeen planted session cookies never block the victim, before or after she signs in again", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const victim = address("lockout");
    await signIn(tabs[0]!, mailpitUrl, victim);
    for (let i = 0; i < 17; i += 1) {
      await plantSession(context, randomUUID(), "d".repeat(64));
    }
    const now = await call(tabs[0]!, "GET", ME);
    expect(now.status).toBe(200);
    expect(now.body?.data?.email).toBe(victim);
    // Signing in again (what a blocked customer would try) works too.
    await signIn(tabs[0]!, mailpitUrl, victim);
    const again = await call(tabs[0]!, "GET", ME);
    expect(again.status).toBe(200);
    expect(again.body?.data?.email).toBe(victim);
  });

  it("planted values under the victim's own session name, and malformed cookies: ignored, the victim stays herself", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const victim = address("victim-name");
    await signIn(tabs[0]!, mailpitUrl, victim);
    const [mine] = await sessionCookies(context);
    await plantSession(context, mine!.session, "e".repeat(64));
    await plantSession(context, mine!.session, "not-a-token");
    await plant(context, "client_hub_s_NOT-A-UUID", "a".repeat(64));
    await plant(context, "client_hub_session", "a".repeat(64));
    const now = await call(tabs[0]!, "GET", ME);
    expect(now.status).toBe(200);
    expect(now.body?.data?.email).toBe(victim);
    expect(await accountSessions(victim)).toBe(1);
  });

  it("LIMIT (documented): cookies of any name planted beyond the server's header limit refuse every request to the host (431), the hub's as any other page", async () => {
    const { context, tabs } = await profileWithTabs(1);
    const who = address("bomb");
    await signIn(tabs[0]!, mailpitUrl, who);
    for (let i = 0; i < 6; i += 1) {
      await plant(context, `bomb${i}`, "x".repeat(3500));
    }
    expect((await call(tabs[0]!, "GET", ME)).status).toBe(431);
    // Nothing of the hub was ended: once those cookies are gone, she is in.
    await context.clearCookies({ domain: ".hub.test" });
    expect((await call(tabs[0]!, "GET", ME)).body?.data?.email).toBe(who);
  });
});

describe("headers too large", () => {
  it("a Cookie header over the server's limit is refused (431) before any route runs, without Set-Cookie", async () => {
    const cookie = Array.from(
      { length: 200 },
      () => `client_hub_s_${randomUUID()}=${"a".repeat(64)}`,
    ).join("; ");
    const response = await fetch(`${hubOriginUrl}${ME}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(431);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The pages: what the customer sees in a tab while the browser's identity
// changes in another one. A recorder in each tab keeps every state of the
// page's text: no state may show the confirmed customer's identity together
// with another customer's data.
// ---------------------------------------------------------------------------

/**
 * A customer signing in through the hub's own page (so the page learns her
 * session's end from the verify answer, as in real life). `endsIn`: the
 * verify answer announces an end that close, and the database's session
 * is made to end then too (a session close to its expiry).
 */
async function signInThroughPage(page: Page, email: string, endsIn: number) {
  let ends = 0;
  await page.route("**/api/client-hub/session/verify", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    ends = Date.now() + endsIn;
    if (json?.data) json.data.expiresAt = new Date(ends).toISOString();
    // Same status and headers (its Set-Cookie included), the end rewritten.
    await route.fulfill({ response, json });
  });
  await page.goto("/espace/connexion");
  await page.getByLabel("Adresse email").fill(email);
  await page.getByRole("button", { name: "Recevoir mon code" }).click();
  const { codeFor } = await import("./support/browser");
  const code = await codeFor(mailpitUrl, email);
  // A complete code is sent at once.
  await page.getByLabel("Code à 8 chiffres").fill(code);
  await page.waitForURL(/\/espace$/);
  await page.unroute("**/api/client-hub/session/verify");
  await db.query(
    `update private.client_hub_sessions s set expires_at = $2
     from private.client_hub_accounts a
     where a.id = s.account_id and a.email = $1 and s.revoked_at is null`,
    [email, new Date(ends).toISOString()],
  );
  return ends;
}

async function customerWithAppointment(label: string, firstName: string) {
  const owner = await createProfessional(`hub-ui-${label}`);
  const business = await createBusiness(owner.userId, {
    name: `Studio ${firstName}`,
  });
  const service = await createService(business.id, {
    name: `Soin de ${firstName}`,
  });
  const email = address(label);
  const client = await createClientRecord(business.id, email, firstName);
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  startsAt.setUTCHours(9, 0, 0, 0);
  await insertAppointment({
    businessId: business.id,
    clientId: client,
    serviceId: service,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
  });
  const { error } = await owner.client.rpc("client_hub_set_access", {
    p_business_id: business.id,
    p_client_id: client,
    p_granted: true,
  });
  if (error) throw error;
  return { email, firstName };
}

async function record(context: BrowserContext) {
  await context.addInitScript(() => {
    const states: string[] = [];
    (window as unknown as { __states: string[] }).__states = states;
    const save = () => {
      const text = document.body?.innerText ?? "";
      if (states[states.length - 1] !== text) states.push(text);
    };
    new MutationObserver(save).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
}

const statesOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __states: string[] }).__states);

describe("the session's end, as the page knows it (the server decides)", () => {
  for (const broadcastChannel of [true, false]) {
    it(`A close to her end signs out (answer held), B signs in from another tab, then A's end passes: B is never shown signed out (BroadcastChannel ${broadcastChannel ? "available" : "unavailable"})`, async () => {
      const alice = await customerWithAppointment("end-a", "Alice");
      const berenice = await customerWithAppointment("end-b", "Bérénice");
      const { context, tabs } = await profileWithTabs(2, { broadcastChannel });
      await record(context);
      const [hubTab, otherTab] = tabs as [Page, Page];
      const ends = await signInThroughPage(hubTab, alice.email, 30_000);
      await hubTab.getByText("Soin de Alice").waitFor();

      // Alice signs out; the server processes it, the answer is held.
      const held = await holdNext(hubTab, "DELETE", SESSION);
      await hubTab.getByRole("button", { name: "Mon compte" }).click();
      await hubTab
        .getByRole("button", { name: "Se déconnecter", exact: true })
        .click();
      await held.processed;

      // Bérénice signs in from the other tab; Alice's tab learns it.
      await signIn(otherTab, mailpitUrl, berenice.email);
      await otherTab.goto("/espace");
      await otherTab.getByText("Soin de Bérénice").waitFor();
      if (broadcastChannel) {
        await otherTab.evaluate(() =>
          new BroadcastChannel("client-hub-session").postMessage({
            type: "check",
          }),
        );
      } else {
        await hubTab.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
      }
      await hubTab.getByText("Soin de Bérénice").waitFor({ timeout: 15_000 });
      held.release();

      // Alice's end passes.
      await hubTab.waitForTimeout(Math.max(0, ends - Date.now()) + 4_000);
      for (const page of [hubTab, otherTab]) {
        expect(new URL(page.url()).pathname).toBe("/espace");
        expect(await page.getByText("Soin de Bérénice").count()).toBe(1);
        expect(await page.getByText(/session a expiré/).count()).toBe(0);
      }
      const now = await call(hubTab, "GET", ME);
      expect(now.status).toBe(200);
      expect(now.body?.data?.email).toBe(berenice.email);
      for (const state of await statesOf(hubTab)) {
        expect(/Alice/.test(state) && /Bérénice/.test(state), state).toBe(
          false,
        );
      }
    }, 120_000);
  }

  it("her own end, really over on the server: the page asks, then says it expired", async () => {
    const alice = await customerWithAppointment("end-own", "Alice");
    const { tabs } = await profileWithTabs(1);
    const [hubTab] = tabs as [Page];
    const ends = await signInThroughPage(hubTab, alice.email, 12_000);
    await hubTab.getByText("Soin de Alice").waitFor();
    await hubTab.waitForURL(/\/espace\/connexion/, {
      timeout: Math.max(0, ends - Date.now()) + 15_000,
    });
    expect(await hubTab.getByText(/Votre session a expiré/).count()).toBe(1);
    expect(await hubTab.getByText("Soin de Alice").count()).toBe(0);
    expect((await call(hubTab, "GET", ME)).status).toBe(401);
  }, 90_000);
});

describe("the pages never show one customer's data under another's identity", () => {
  for (const broadcastChannel of [true, false]) {
    it(`another customer signed in from another tab (BroadcastChannel ${broadcastChannel ? "available" : "unavailable"}): this tab shows her only once confirmed, never mixed`, async () => {
      const alice = await customerWithAppointment("alice", "Alice");
      const berenice = await customerWithAppointment("berenice", "Bérénice");
      const { context, tabs } = await profileWithTabs(2, { broadcastChannel });
      await record(context);
      const [hubTab, otherTab] = tabs as [Page, Page];
      await signIn(hubTab, mailpitUrl, alice.email);
      await hubTab.goto("/espace");
      await hubTab.getByText("Soin de Alice").waitFor();

      // Bérénice signs in from the other tab.
      await signIn(otherTab, mailpitUrl, berenice.email);
      if (broadcastChannel) {
        // What the hub's sign-in page posts once signed in.
        await otherTab.evaluate(() =>
          new BroadcastChannel("client-hub-session").postMessage({
            type: "signed-in",
          }),
        );
      } else {
        // No message can arrive: the tab learns it when it is shown again.
        await hubTab.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
      }
      await hubTab.getByText("Soin de Bérénice").waitFor({ timeout: 15_000 });

      const states = await statesOf(hubTab);
      for (const state of states) {
        const alicesIdentity = /Alice/.test(state);
        const berenicesData = /Bérénice/.test(state);
        expect(alicesIdentity && berenicesData, state).toBe(false);
      }
      expect(await hubTab.getByText("Soin de Alice").count()).toBe(0);
    });
  }

  for (const broadcastChannel of [true, false]) {
    it(`the pages: A signs out (answer held), B signs in from another tab, then A's answer arrives (BroadcastChannel ${broadcastChannel ? "available" : "unavailable"}): B is shown in both tabs, never signed out`, async () => {
      const alice = await customerWithAppointment("out-ui-a", "Alice");
      const berenice = await customerWithAppointment("out-ui-b", "Bérénice");
      const { context, tabs } = await profileWithTabs(2, { broadcastChannel });
      await record(context);
      const [hubTab, otherTab] = tabs as [Page, Page];
      await signIn(hubTab, mailpitUrl, alice.email);
      await hubTab.goto("/espace");
      await hubTab.getByText("Soin de Alice").waitFor();

      // Alice signs out from the page; the server processes it, the answer
      // is held.
      const held = await holdNext(hubTab, "DELETE", SESSION);
      await hubTab.getByRole("button", { name: "Mon compte" }).click();
      await hubTab
        .getByRole("button", { name: "Se déconnecter", exact: true })
        .click();
      await held.processed;

      // Bérénice signs in from the other tab and uses her space.
      await signIn(otherTab, mailpitUrl, berenice.email);
      await otherTab.goto("/espace");
      await otherTab.getByText("Soin de Bérénice").waitFor();
      if (broadcastChannel) {
        await otherTab.evaluate(() =>
          new BroadcastChannel("client-hub-session").postMessage({
            type: "check",
          }),
        );
      }

      // Alice's sign-out answer arrives now.
      held.release();
      await hubTab.getByText("Soin de Bérénice").waitFor({ timeout: 15_000 });
      await hubTab.waitForTimeout(1_000);

      for (const page of [hubTab, otherTab]) {
        expect(new URL(page.url()).pathname).toBe("/espace");
        expect(await page.getByText("Soin de Bérénice").count()).toBe(1);
        expect(await page.getByText("Soin de Alice").count()).toBe(0);
      }
      const now = await call(otherTab, "GET", ME);
      expect(now.status).toBe(200);
      expect(now.body?.data?.email).toBe(berenice.email);
      for (const state of await statesOf(hubTab)) {
        expect(/Alice/.test(state) && /Bérénice/.test(state), state).toBe(
          false,
        );
      }
    });
  }

  it("a read of a business both customers use, served for the other one (the cookie changed under this tab): her data stays invisible until she is confirmed", async () => {
    // One business, two authorized customers, each with an appointment.
    const owner = await createProfessional("hub-ui-shared");
    const business = await createBusiness(owner.userId, {
      name: "Studio Commun",
    });
    const customers = [];
    for (const firstName of ["Alice", "Bérénice"]) {
      const service = await createService(business.id, {
        name: `Soin de ${firstName}`,
      });
      const email = address(`shared-${firstName === "Alice" ? "a" : "b"}`);
      const client = await createClientRecord(business.id, email, firstName);
      const startsAt = new Date(Date.now() + 3 * 86_400_000);
      // One business: their appointments must not overlap.
      startsAt.setUTCHours(firstName === "Alice" ? 9 : 11, 0, 0, 0);
      await insertAppointment({
        businessId: business.id,
        clientId: client,
        serviceId: service,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
      });
      const { error } = await owner.client.rpc("client_hub_set_access", {
        p_business_id: business.id,
        p_client_id: client,
        p_granted: true,
      });
      if (error) throw error;
      customers.push(email);
    }
    const [alice, berenice] = customers as [string, string];

    const { tabs } = await profileWithTabs(2, { broadcastChannel: false });
    const [hubTab, otherTab] = tabs as [Page, Page];
    await signIn(hubTab, mailpitUrl, alice);
    await hubTab.goto("/espace");
    await hubTab.getByText("Soin de Alice").waitFor();

    // Bérénice becomes the browser's identity; no message reaches this
    // tab. Its next check of who is signed in is held at the ingress.
    await signIn(otherTab, mailpitUrl, berenice);
    const check = await holdNext(hubTab, "GET", ME);
    // Alice's screen opens the business's appointments: that read leaves
    // with the browser's cookies, and is served for Bérénice.
    await hubTab.getByRole("link", { name: "Tous mes rendez-vous" }).click();
    // (Without the identity check, no check is made at all: bounded wait.)
    await Promise.race([check.processed, hubTab.waitForTimeout(5000)]);
    await hubTab.waitForTimeout(1000);
    expect(await hubTab.getByText("Soin de Bérénice").isVisible()).toBe(false);
    expect(await hubTab.getByText("Soin de Alice").isVisible()).toBe(false);

    // Confirmed: her own screens, with her data.
    check.release();
    await hubTab.getByText("Soin de Bérénice").waitFor({ timeout: 15_000 });
    expect(await hubTab.getByText("Soin de Alice").count()).toBe(0);
  });
});
