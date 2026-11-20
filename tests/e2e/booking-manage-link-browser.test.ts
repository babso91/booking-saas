import { randomUUID } from "node:crypto";

import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { writeFileSync, mkdirSync } from "node:fs";

import {
  createService,
  db,
  everyDay,
  setWeeklyHours,
} from "../integration/support/fixtures";
import { inviteAccount } from "./support/beta";
import { call, launchBrowser } from "./support/browser";
import { capture } from "./support/capture";
import { HUB_URL, startIngress } from "./support/hub-ingress";
import { APP, Browser as AppBrowser } from "./support/studio";

// The tester's report on her phone (Higani backlog, point 78): she booked
// as a guest, opened « Gérer ou annuler mon rendez-vous » from the email she
// received and landed in an empty space. Here, in real Chromium with a
// phone's screen, against the production build behind its TLS ingress and
// the emails really delivered to Mailpit: the booking is made from one
// browser, the link of the real email is opened in another one that has
// never seen the hub, she types the code she receives, arrives on that very
// appointment and cancels it within the business's policy.

const { mailpitUrl, hubProxySecret, apiUrl, serviceRoleKey } = inject("e2e");
const PASSWORD = "correct-horse-battery";
const TZ = "Europe/Paris";

let browser: Browser;
let ingress: Awaited<ReturnType<typeof startIngress>>;
const opened: BrowserContext[] = [];

/** A browser that has never visited the hub, with a phone's screen. */
async function phone() {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: HUB_URL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "fr-FR",
  });
  opened.push(context);
  return context.newPage();
}

type MailpitMessage = { ID: string; Subject: string };

/** The newest message to `address` whose subject matches, as delivered. */
async function messageTo(address: string, subject: RegExp) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const list = (await (
      await fetch(
        `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
      )
    ).json()) as { messages?: MailpitMessage[] };
    const found = list.messages?.find((m) => subject.test(m.Subject));
    if (found) {
      const message = (await (
        await fetch(`${mailpitUrl}/api/v1/message/${found.ID}`)
      ).json()) as { Subject: string; Text: string };
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Nothing matching ${subject} was emailed to ${address}`);
}

/** A real professional, signed in to her dashboard (her own session). */
async function professional() {
  const email = `pro-${randomUUID().slice(0, 8)}@test.local`;
  const created = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  expect(created.ok).toBe(true);
  await inviteAccount(email, ((await created.json()) as { id: string }).id);
  const pro = new AppBrowser();
  const signedIn = await pro
    .supabase()
    .auth.signInWithPassword({ email, password: PASSWORD });
  expect(signedIn.error).toBeNull();
  const slug = `salon-${randomUUID().slice(0, 8)}`;
  const { error } = await pro.supabase().rpc("complete_onboarding", {
    p_first_name: "Maya",
    p_last_name: "Test",
    p_business_name: "Salon Maya",
    p_slug: slug,
    p_timezone: TZ,
    p_phone: "06 12 34 56 78",
    p_minimum_booking_notice_minutes: 0,
    p_maximum_booking_advance_days: 30,
    p_buffer_minutes: 0,
  });
  expect(error).toBeNull();
  const { rows } = await db.query<{ id: string }>(
    "select id from public.businesses where slug = $1",
    [slug],
  );
  return { pro, business: { id: rows[0]!.id, slug } };
}

/** Her dashboard in a browser of its own, signed in with her cookies. */
async function dashboard(pro: AppBrowser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "fr-FR",
  });
  opened.push(context);
  await context.addCookies(
    [...pro.cookies].map(([name, value]) => ({ name, value, url: APP })),
  );
  return context.newPage();
}

beforeAll(async () => {
  ingress = await startIngress(hubProxySecret);
  browser = await launchBrowser();
});
afterAll(async () => {
  for (const context of opened) await context.close().catch(() => undefined);
  await browser?.close();
  await ingress?.stop();
});

describe("point 78: « Gérer ou annuler mon rendez-vous » from the email, on a phone", () => {
  it("a guest's link, opened in a fresh browser, leads after her code to that appointment, which she cancels", async () => {
    // Her salon: hours every day, cancellation online up to 24 h before.
    // She has never opened her customer's record in the Hub.
    const { pro, business } = await professional();
    await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
    await db.query(
      "update public.business_settings set slot_interval_minutes = 30, cancellation_lead_minutes = 1440 where business_id = $1",
      [business.id],
    );
    const service = await createService(business.id, {
      name: "Rehaussement",
      durationMinutes: 60,
      priceCents: 5500,
    });

    // She books as a guest, from a first browser (the public route, as the
    // booking page calls it).
    const email = `ines-${randomUUID().slice(0, 8)}@client.test`;
    const booking = await phone();
    await booking.goto("/espace/connexion");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
      new Date(Date.now() + 5 * 86_400_000),
    );
    const slots = await call(
      booking,
      "GET",
      `/api/public/businesses/${business.slug}/availability?serviceId=${service}&date=${date}`,
    );
    const slot = (
      slots.body!.data!.slots as { startsAt: string; localStartsAt: string }[]
    ).find((s) => s.localStartsAt.slice(11, 16) === "10:00")!;
    const created = await call(booking, "POST", "/api/bookings", {
      slug: business.slug,
      serviceId: service,
      startsAt: slot.startsAt,
      firstName: "Inès",
      email,
      requestId: randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const appointmentId = (
      created.body!.data!.booking as { appointmentId: string }
    ).appointmentId;

    // The email she really receives, and its link.
    const confirmation = await messageTo(email, /confirm/i);
    mkdirSync("test-results/screens", { recursive: true });
    writeFileSync(
      "test-results/screens/manage-link-01-confirmation-email.txt",
      `${confirmation.Subject}\n\n${confirmation.Text}`,
    );
    const link = confirmation.Text.match(
      /Gérer ou annuler mon rendez-vous : (\S+)/,
    )?.[1];
    expect(link).toBe(
      `${HUB_URL}/espace/connexion?next=${encodeURIComponent(
        `/espace/${business.id}/rendez-vous/${appointmentId}`,
      )}`,
    );

    // Another browser, never signed in: the link, her address, her code.
    const tab: Page = await phone();
    await tab.goto(link!);
    await capture(tab, "manage-link-02-sign-in-from-email");
    await tab.getByLabel("Adresse email").fill(email);
    await tab.getByRole("button", { name: "Recevoir mon code" }).click();
    const code = (await messageTo(email, /^\d{8}/)).Subject.slice(0, 8);
    await tab.getByLabel("Code à 8 chiffres").fill(code);
    await capture(tab, "manage-link-03-code");
    // The 8th digit submits the code by itself.

    // That very appointment, not an empty space.
    await tab.waitForURL(
      `${HUB_URL}/espace/${business.id}/rendez-vous/${appointmentId}`,
    );
    await expect
      .poll(() => tab.getByText("Rehaussement").first().isVisible(), {
        timeout: 15_000,
      })
      .toBe(true);
    await capture(tab, "manage-link-04-her-appointment");

    // She cancels, within the policy.
    await tab.getByRole("button", { name: "Annuler ce rendez-vous" }).click();
    await capture(tab, "manage-link-05-confirm-cancellation");
    await tab.getByRole("button", { name: "Confirmer l’annulation" }).click();
    await expect
      .poll(() => tab.getByText("Annulé", { exact: true }).first().isVisible())
      .toBe(true);
    await capture(tab, "manage-link-06-cancelled");
    const { rows } = await db.query(
      "select status from public.appointments where id = $1",
      [appointmentId],
    );
    expect(rows[0].status).toBe("cancelled");

    // Her professional's agenda, on that day: « Annulé ».
    const agenda = await dashboard(pro);
    await agenda.goto(`${APP}/app?date=${date}`);
    await agenda.getByLabel("Afficher les rendez-vous annulés").check();
    const card = agenda.getByText("Inès").first();
    await expect.poll(() => card.isVisible(), { timeout: 20_000 }).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        agenda.getByText("Annulé", { exact: true }).first().isVisible(),
      )
      .toBe(true);
    await capture(agenda, "manage-link-07-pro-agenda-cancelled");

    // The link opened again: the same appointment, cancelled, no action.
    await tab.goto(link!);
    await tab.waitForURL(
      `${HUB_URL}/espace/${business.id}/rendez-vous/${appointmentId}`,
    );
    await expect
      .poll(() => tab.getByText("Annulé", { exact: true }).first().isVisible())
      .toBe(true);
    expect(
      await tab.getByRole("button", { name: "Annuler ce rendez-vous" }).count(),
    ).toBe(0);
  });
});
