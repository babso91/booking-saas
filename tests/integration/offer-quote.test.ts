import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { POST as postBooking } from "@/app/api/bookings/route";
import { POST as postQuote } from "@/app/api/public/businesses/[slug]/offer-quote/route";

import {
  createBusiness,
  createProfessional,
  createService,
  dateInDays,
  db,
  env,
  everyDay,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Offers, codes and the quote tied to the slot (docs/OFFER_QUOTE_CONTRACT.md)
// through the public routes as the booking page calls them; the owner's
// promotions through PostgREST. Recipe of R4-03: service 6000 + option
// 1500 = basis 7500, −15 % → 1125 off, total 6375.

vi.mock("@/features/notifications/data/kick", () => ({
  kickEmailOutbox: () => undefined,
}));
vi.mock("@/features/calendar/data/outbound-kick", () => ({
  kickCalendarOutbound: () => undefined,
}));

const SECRET = "offers-test-proxy-secret-0123456789abcdef";
const BASE = "http://localhost:3000";

beforeAll(() => {
  process.env.BOOKING_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
});

function request(path: string, body: unknown, ip = randomIp()) {
  return new NextRequest(new URL(path, BASE), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-booking-proxy-secret": SECRET,
      "x-booking-client-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

let owner: Professional;
let business: TestBusiness;
let serviceId: string;
let choiceId: string;

type Quote = {
  quoteRef: string;
  baseCents: number;
  optionsCents: number;
  discountCents: number;
  totalCents: number;
  discountLabel: string | null;
  discountSource: string | null;
};

async function quote(startsAt: string, coupon?: string, ip?: string) {
  const response = await postQuote(
    request(
      `/api/public/businesses/${business.slug}/offer-quote`,
      {
        serviceId,
        optionChoiceIds: [choiceId],
        startsAt,
        ...(coupon ? { coupon } : {}),
      },
      ip,
    ),
    { params: Promise.resolve({ slug: business.slug }) },
  );
  return { status: response.status, body: await response.json() };
}

async function book(
  startsAt: string,
  quoteRef?: string,
  requestId = randomUUID(),
  email = `offre-${randomUUID().slice(0, 8)}@client.test`,
) {
  const response = await postBooking(
    request("/api/bookings", {
      slug: business.slug,
      serviceId,
      optionChoiceIds: [choiceId],
      startsAt,
      firstName: "Nina",
      email,
      requestId,
      ...(quoteRef ? { quoteRef } : {}),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const promotion = async (input: Record<string, unknown>) => {
  const { data, error } = await owner.client.rpc("promotion_create", {
    p_business_id: business.id,
    p_input: input as never,
  });
  if (error) throw new Error(error.message);
  return data as { id: string; version: number };
};

/** 10:00 or 15:00 Paris time, `days` ahead (UTC+1 in winter, UTC+2 in summer). */
function paris(days: number, hour: number) {
  const date = dateInDays(days);
  const probe = new Date(`${date}T12:00:00Z`);
  const offset =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(probe) === "14"
      ? 2
      : 1;
  return `${date}T${String(hour - offset).padStart(2, "0")}:00:00.000Z`;
}

beforeAll(async () => {
  owner = await createProfessional("offers-owner");
  business = await createBusiness(owner.userId, { timezone: "Europe/Paris" });
  serviceId = await createService(business.id, {
    name: "Pose",
    durationMinutes: 60,
    priceCents: 6000,
  });
  const { rows } = await db.query(
    `with o as (
       insert into public.service_options (business_id, service_id, question)
       values ($1, $2, 'Longueur') returning id
     )
     insert into public.service_option_choices (business_id, option_id, label, price_delta_cents)
     select $1, o.id, 'Longs', 1500 from o returning id`,
    [business.id, serviceId],
  );
  choiceId = rows[0].id;
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
});

describe("quote", () => {
  it("prices one slot exactly: −15 % on mornings only, a code preferred, the offer back without it", async () => {
    await promotion({
      kind: "offer",
      label: "Matinées −15 %",
      percentOff: 15,
      localStartMinute: 8 * 60,
      localEndMinute: 12 * 60,
    });
    await promotion({
      kind: "code",
      code: "bienvenue",
      label: "Bienvenue −10 €",
      amountOffCents: 1000,
    });

    const morning = await quote(paris(6, 10));
    expect(morning.status).toBe(200);
    expect(morning.body.data).toMatchObject({
      baseCents: 6000,
      optionsCents: 1500,
      discountCents: 1125,
      totalCents: 6375,
      discountLabel: "Matinées −15 %",
      discountSource: "offer",
      depositCents: null,
    });
    const afternoon = await quote(paris(6, 15));
    expect(afternoon.body.data).toMatchObject({
      discountCents: 0,
      totalCents: 7500,
    });

    const coded = await quote(paris(6, 10), "  Bienvenue ");
    expect(coded.body.data).toMatchObject({
      discountCents: 1000,
      totalCents: 6500,
      discountSource: "code",
    });
    const refused = await quote(paris(6, 10), "FAUX-CODE");
    expect(refused).toMatchObject({
      status: 422,
      body: { error: { code: "coupon_refused" } },
    });
  });

  it("stops a network that keeps guessing codes", async () => {
    const ip = randomIp();
    for (let i = 0; i < 20; i += 1) {
      expect((await quote(paris(7, 15), `ESSAI${i}`, ip)).status).toBe(422);
    }
    expect((await quote(paris(7, 15), "ESSAI21", ip)).status).toBe(429);
  });
});

describe("booking with a quote", () => {
  it("books the quoted total, replays the same receipt, and refuses a changed quote", async () => {
    const startsAt = paris(8, 10);
    const q = (await quote(startsAt)).body.data as Quote;
    const requestId = randomUUID();
    const email = `offre-${randomUUID().slice(0, 8)}@client.test`;
    const booked = await book(startsAt, q.quoteRef, requestId, email);
    expect(booked.status).toBe(201);
    expect(booked.body.data.booking.priceCents).toBe(6375);
    const { rows } = await db.query(
      "select price_cents_snapshot from public.appointments where id = $1",
      [booked.body.data.booking.appointmentId],
    );
    expect(rows[0].price_cents_snapshot).toBe(6375);

    // Lost answer: the same request answers the same receipt, even with the
    // quote expired since.
    await db.query(
      "update private.offer_quotes set valid_until = now() - interval '1 second' where ref = $1",
      [q.quoteRef],
    );
    const again = await book(startsAt, q.quoteRef, requestId, email);
    expect(again.status).toBe(200);
    expect(again.body.data.booking).toMatchObject({
      appointmentId: booked.body.data.booking.appointmentId,
      priceCents: 6375,
    });

    // An expired quote on a new booking: quote_changed, nothing booked.
    const other = paris(8, 11);
    const stale = (await quote(other)).body.data as Quote;
    await db.query(
      "update private.offer_quotes set valid_until = now() - interval '1 second' where ref = $1",
      [stale.quoteRef],
    );
    const refused = await book(other, stale.quoteRef);
    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: "quote_changed" } },
    });
  });

  it("the last use of a quota goes to one booking; the other gets promotion_exhausted, never the base price", async () => {
    const limited = await promotion({
      kind: "code",
      code: "DERNIERE",
      label: "Dernière place −50 %",
      percentOff: 50,
      quotaLimit: 1,
    });
    const a = paris(9, 10);
    const b = paris(9, 13);
    const qa = (await quote(a, "derniere")).body.data as Quote;
    const qb = (await quote(b, "derniere")).body.data as Quote;
    expect(qa.totalCents).toBe(3750);

    const [first, second] = await Promise.all([
      book(a, qa.quoteRef),
      book(b, qb.quoteRef),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.code).toBe("promotion_exhausted");
    const { rows } = await db.query(
      "select quota_used from private.promotions where id = $1",
      [limited.id],
    );
    expect(rows[0].quota_used).toBe(1);

    // Cancelling the winner gives the use back, once.
    const winner = first.status === 201 ? first : second;
    const id = winner.body.data.booking.appointmentId;
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [id],
    );
    const after = await db.query(
      "select quota_used from private.promotions where id = $1",
      [limited.id],
    );
    expect(after.rows[0].quota_used).toBe(0);
    const { rows: released } = await db.query(
      "select released_at is not null as released from private.promotion_consumptions where appointment_id = $1",
      [id],
    );
    expect(released[0].released).toBe(true);

    // The use came back once: another booking takes it, and cancelling the
    // first one again gives nothing more back.
    const c = paris(9, 16);
    const qc = (await quote(c, "derniere")).body.data as Quote;
    expect((await book(c, qc.quoteRef)).status).toBe(201);
    await db.query(
      "update public.appointments set status = 'cancelled', updated_at = now() where id = $1",
      [id],
    );
    const final = await db.query(
      "select quota_used from private.promotions where id = $1",
      [limited.id],
    );
    expect(final.rows[0].quota_used).toBe(1);
  });

  it("refuses an empty list of services or days (it would mean all)", async () => {
    for (const input of [
      { kind: "offer", label: "Vide", percentOff: 10, serviceIds: [] },
      { kind: "offer", label: "Vide", percentOff: 10, weekdays: [] },
    ]) {
      const { error } = await owner.client.rpc("promotion_create", {
        p_business_id: business.id,
        p_input: input as never,
      });
      expect(error?.message).toBe("invalid_input");
    }
  });

  it("a taken slot rolls the quota back", async () => {
    const limited = await promotion({
      kind: "code",
      code: "UNIQUE",
      label: "Une fois −20 %",
      percentOff: 20,
      quotaLimit: 1,
    });
    const startsAt = paris(10, 10);
    const q = (await quote(startsAt, "unique")).body.data as Quote;
    expect((await book(startsAt)).status).toBe(201); // someone books it first, without the code
    const lost = await book(startsAt, q.quoteRef);
    expect(lost.status).toBe(409);
    expect(["slot_unavailable", "quote_changed"]).toContain(
      lost.body.error.code,
    );
    const { rows } = await db.query(
      "select quota_used from private.promotions where id = $1",
      [limited.id],
    );
    expect(rows[0].quota_used).toBe(0);
  });

  it("a paused offer makes its quote stale", async () => {
    const paused = await promotion({
      kind: "code",
      code: "PAUSE",
      label: "Pause",
      percentOff: 5,
    });
    const startsAt = paris(11, 10);
    const q = (await quote(startsAt, "pause")).body.data as Quote;
    const { error } = await owner.client.rpc("promotion_set_state", {
      p_business_id: business.id,
      p_promotion_id: paused.id,
      p_state: "paused",
      p_expected_version: paused.version,
    });
    expect(error).toBeNull();
    expect((await book(startsAt, q.quoteRef)).body.error.code).toBe(
      "quote_changed",
    );
  });
});
