import type { Page, Route } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addDays,
  businessToday,
  dayLabel,
} from "@/features/public-booking/client/business-time";

import { capture } from "./support/capture";
import { signedInPage } from "./support/ecrin";
import { behindIngress, E2E_PROXY_SECRET } from "./support/ingress";
import { APP, Browser, db, professionalWithVisit } from "./support/studio";

// Higani backlog, points 72 and 202: a customer's connection drops while
// she confirms her booking on her phone. On the real public page, in
// Chromium, against PostgreSQL: whatever the moment of the cut, a second
// try never books twice, and she ends up knowing whether her appointment
// exists, with the server's own answer. Three cuts:
// - the server booked, the answer was lost, she taps « Confirmer » again;
// - the server booked, the answer was lost, she reloads the page later;
// - the request never reached the server, she sends it again.

const TZ = "Europe/Paris";

let business: { id: string; slug: string };

beforeAll(async () => {
  const pro = await professionalWithVisit("Lina", "Lou");
  const { rows } = await db.query<{ slug: string }>(
    "select slug from public.businesses where id = $1",
    [pro.businessId],
  );
  business = { id: pro.businessId, slug: rows[0]!.slug };
  // Open every day, 08:00–20:00: tomorrow always has slots.
  await db.query("delete from public.business_hours where business_id = $1", [
    business.id,
  ]);
  for (let weekday = 0; weekday < 7; weekday += 1)
    await db.query(
      `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
       values ($1, $2, '08:00', '20:00')`,
      [business.id, weekday],
    );
});

type Sent = { requestId: string; email: string; startsAt: string };

/**
 * Cuts the connection on the next `POST /api/bookings`, once. With
 * `afterServer`, the request reaches the server and is answered there (the
 * booking is made), then the answer is lost on the way back. Every request
 * sent is recorded, as the browser sent it.
 */
async function cutOnce(page: Page, address: string, afterServer: boolean) {
  const sent: Sent[] = [];
  let cut = false;
  await page.route("**/api/bookings", async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    sent.push(request.postDataJSON() as Sent);
    if (cut) return route.fallback();
    cut = true;
    if (afterServer) {
      const answered = await route.fetch({
        headers: {
          ...request.headers(),
          "x-booking-proxy-secret": E2E_PROXY_SECRET,
          "x-booking-client-ip": address,
        },
      });
      expect(answered.status()).toBe(201);
    }
    await route.abort("internetdisconnected");
  });
  return sent;
}

/** Her phone on the business page, up to « Vérifiez et confirmez ». */
async function upToReview(address: string, email: string) {
  const { page, errors } = await signedInPage(new Browser(), {
    appearance: null,
    width: 390,
    height: 860,
    phone: true,
  });
  await behindIngress(page.context(), address);
  await page.goto(`${APP}/b/${business.slug}`);
  await page.getByRole("button", { name: /Rehaussement de cils/ }).click();
  await page.getByRole("heading", { name: "Choisissez un créneau" }).waitFor();
  const tomorrow = addDays(businessToday(TZ), 1);
  await page
    .getByRole("button", { name: new RegExp(`, ${dayLabel(tomorrow)}$`) })
    .click();
  await page
    .getByRole("list", { name: `Créneaux du ${dayLabel(tomorrow)}` })
    .getByRole("button")
    .first()
    .click();
  await page.getByRole("heading", { name: "Vos coordonnées" }).waitFor();
  await page.getByLabel(/^Prénom/).fill("Inès");
  await page.getByLabel(/^Email/).fill(email);
  await page.getByRole("button", { name: "Continuer" }).click();
  await page.getByRole("heading", { name: "Vérifiez et confirmez" }).waitFor();
  return { page, errors };
}

/** The next booking answer read by the page, with its body. */
function nextAnswer(page: Page) {
  return page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/bookings" &&
        response.request().method() === "POST",
    )
    .then(async (response) => ({
      status: response.status(),
      body: (await response.json()) as {
        data?: { booking: { appointmentId: string; replayed: boolean } };
        error?: { code: string };
      },
    }));
}

/** Her appointments in this business, and their confirmation emails. */
async function booked(email: string) {
  const { rows } = await db.query<{ id: string; confirmations: number }>(
    `select a.id,
            (select count(*)::int from public.email_events e
              where e.appointment_id = a.id
                and e.type = 'booking_confirmation') as confirmations
       from public.appointments a
      where a.business_id = $1 and a.client_email_snapshot = $2`,
    [business.id, email],
  );
  return rows;
}

const unconfirmed = (page: Page) =>
  page.getByText("Réservation non confirmée").waitFor();

describe("points 72 and 202: her connection drops while she confirms", () => {
  it("booked, answer lost: tapping « Confirmer » again answers the same appointment", async () => {
    const email = `ines-tap-${business.slug}@client.test.local`;
    const address = "203.0.113.41";
    const { page, errors } = await upToReview(address, email);
    const sent = await cutOnce(page, address, true);

    await page
      .getByRole("button", { name: /Confirmer la réservation/ })
      .click();
    await unconfirmed(page);
    await page
      .getByText(
        "Renvoyer la même demande ne crée jamais un second rendez-vous.",
      )
      .waitFor();
    await capture(page, "network-recovery-01-answer-lost");
    // The server had booked it: one appointment already.
    const before = await booked(email);
    expect(before).toHaveLength(1);

    // Her reflex: the same button, once more.
    const answer = nextAnswer(page);
    await page
      .getByRole("button", { name: /Confirmer la réservation/ })
      .click();
    const { status, body } = await answer;
    expect(status).toBe(200);
    expect(body.data?.booking).toMatchObject({
      appointmentId: before[0]!.id,
      replayed: true,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);

    await page.getByRole("heading", { name: "Rendez-vous confirmé" }).waitFor();
    await page.getByText(/rien n’a été réservé en double/).waitFor();
    await capture(page, "network-recovery-02-same-appointment");
    expect(await page.getByText("Réservation non confirmée").count()).toBe(0);
    expect(await booked(email)).toEqual([
      { id: before[0]!.id, confirmations: 1 },
    ]);
    expect(errors).toEqual([]);
  });

  it("booked, answer lost: after a reload, the same request is offered back and answers the same appointment", async () => {
    const email = `ines-reload-${business.slug}@client.test.local`;
    const address = "203.0.113.42";
    const { page, errors } = await upToReview(address, email);
    const sent = await cutOnce(page, address, true);

    await page
      .getByRole("button", { name: /Confirmer la réservation/ })
      .click();
    await unconfirmed(page);
    const before = await booked(email);
    expect(before).toHaveLength(1);

    // She leaves it, then comes back to the page in the same tab.
    await page.reload();
    await unconfirmed(page);
    await page
      .getByText(
        new RegExp(
          `Rehaussement de cils, .+ au nom de Inès \\(${email.replace(/[.]/g, "\\.")}\\)`,
        ),
      )
      .waitFor();
    await capture(page, "network-recovery-03-offered-back-after-reload");

    const answer = nextAnswer(page);
    await page
      .getByRole("button", { name: "Renvoyer la même demande" })
      .click();
    const { status, body } = await answer;
    expect(status).toBe(200);
    expect(body.data?.booking).toMatchObject({
      appointmentId: before[0]!.id,
      replayed: true,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);

    await page.getByRole("heading", { name: "Rendez-vous confirmé" }).waitFor();
    await page.getByText(/rien n’a été réservé en double/).waitFor();
    expect(await booked(email)).toEqual([
      { id: before[0]!.id, confirmations: 1 },
    ]);
    // Answered: nothing left to offer back on the next visit.
    await page.reload();
    await page.getByRole("button", { name: /Rehaussement de cils/ }).waitFor();
    expect(await page.getByText("Réservation non confirmée").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("never reached the server: sending it again books it once", async () => {
    const email = `ines-offline-${business.slug}@client.test.local`;
    const address = "203.0.113.43";
    const { page, errors } = await upToReview(address, email);
    const sent = await cutOnce(page, address, false);

    await page
      .getByRole("button", { name: /Confirmer la réservation/ })
      .click();
    await unconfirmed(page);
    // Nothing booked yet, and she is not told it is.
    expect(await booked(email)).toEqual([]);
    expect(
      await page.getByRole("heading", { name: "Rendez-vous confirmé" }).count(),
    ).toBe(0);

    const answer = nextAnswer(page);
    await page
      .getByRole("button", { name: "Renvoyer la même demande" })
      .click();
    const { status, body } = await answer;
    expect(status).toBe(201);
    expect(body.data?.booking.replayed).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);

    await page.getByRole("heading", { name: "Rendez-vous confirmé" }).waitFor();
    await page.getByText("Votre rendez-vous est enregistré.").waitFor();
    await capture(page, "network-recovery-04-booked-once");
    const after = await booked(email);
    expect(after).toEqual([
      { id: body.data!.booking.appointmentId, confirmations: 1 },
    ]);
    expect(errors).toEqual([]);
  });
});
