import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as postBooking } from "@/app/api/bookings/route";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  addException,
  createBusiness,
  createProfessional,
  createService,
  db,
  dateInDays,
  env,
  everyDay,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// The public booking journey (PR #21) through the real route handler, the
// service-role call and PostgreSQL: idempotency of ambiguous retries,
// concurrency on one slot, abuse limits, isolation and what is (not)
// exposed. The booking engine itself is covered by public-booking*.test.ts,
// concurrency.test.ts and schedule-*.test.ts.

const DATE = dateInDays(16);

let owner: Professional;
let business: TestBusiness;
let other: TestBusiness;
let service: string;
let otherService: string;

const at = (time: string, date = DATE) =>
  zonedLocalToUtc(`${date}T${time}`, "Europe/Paris").toISOString();

type Body = Record<string, unknown>;

/** A fresh address per test unless given: the per-address limit is tested on its own. */
let address = "";

function post(body: Body | string, ip = address) {
  return postBooking(
    new Request("http://localhost/api/bookings", {
      method: "POST",
      headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const body = (overrides: Body = {}): Body => ({
  slug: business.slug,
  serviceId: service,
  startsAt: at("10:00"),
  firstName: "Léa",
  lastName: "Martin",
  email: `lea-${randomUUID().slice(0, 8)}@example.test`,
  phone: "06 12 34 56 78",
  requestId: randomUUID(),
  ...overrides,
});

async function appointments(businessId = business.id) {
  const { rows } = await db.query<{
    id: string;
    client_id: string;
    status: string;
    price_cents_snapshot: number;
    service_name_snapshot: string;
  }>(
    `select id, client_id, status::text, price_cents_snapshot, service_name_snapshot
     from public.appointments where business_id = $1 order by starts_at`,
    [businessId],
  );
  return rows;
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  owner = await createProfessional("public-booking-guarantees");
});

beforeEach(async () => {
  address = `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID()}`;
  business = await createBusiness(owner.userId, {
    settings: { slot_interval_minutes: 30, buffer_minutes: 0 },
  });
  other = await createBusiness(owner.userId);
  service = await createService(business.id, {
    name: "Rehaussement",
    durationMinutes: 60,
    priceCents: 6500,
  });
  otherService = await createService(other.id, { name: "Autre" });
  await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
  await setWeeklyHours(other.id, everyDay(["09:00", "18:00"]));
});

describe("the journey", () => {
  it("books, links the customer in the CRM, snapshots the price and answers only the booking", async () => {
    const sent = body();
    const response = await post(sent);
    expect(response.status).toBe(201);
    const { data } = await response.json();
    expect(data.booking).toEqual({
      appointmentId: expect.any(String),
      startsAt: at("10:00"),
      endsAt: at("11:00"),
      timezone: "Europe/Paris",
      serviceName: "Rehaussement",
      durationMinutes: 60,
      priceCents: 6500,
      currency: "EUR",
      businessName: expect.any(String),
      status: "confirmed",
      replayed: false,
    });

    // The agenda reads appointments of the business: it is there.
    const [booked] = await appointments();
    expect(booked).toMatchObject({
      id: data.booking.appointmentId,
      status: "confirmed",
      price_cents_snapshot: 6500,
    });
    const { rows: clients } = await db.query(
      "select id, first_name, last_name, email, phone from public.clients where business_id = $1",
      [business.id],
    );
    expect(clients).toEqual([
      {
        id: booked!.client_id,
        first_name: "Léa",
        last_name: "Martin",
        email: sent.email,
        phone: "06 12 34 56 78",
      },
    ]);

    // A later price change never rewrites the booked price.
    await db.query(
      "update public.services set price_cents = 9900 where id = $1",
      [service],
    );
    expect((await appointments())[0]!.price_cents_snapshot).toBe(6500);

    // The confirmation is recorded in the outbox; nothing sends it yet.
    const { rows: emails } = await db.query(
      "select type::text, status::text from public.email_events where appointment_id = $1",
      [booked!.id],
    );
    expect(emails).toEqual([
      { type: "booking_confirmation", status: "pending" },
    ]);
  });

  it("links an existing customer by canonical email, without rewriting her record or revealing it", async () => {
    const first = body({ email: "Camille@Example.test", firstName: "Camille" });
    expect((await post(first)).status).toBe(201);
    const again = await post(
      body({
        startsAt: at("14:00"),
        email: "camille@example.TEST",
        firstName: "Usurpation",
        lastName: "Autre",
      }),
    );
    expect(again.status).toBe(201);
    const answer = (await again.json()).data.booking;
    // Nothing of the customer record in the answer.
    expect(Object.keys(answer).sort()).toEqual(
      [
        "appointmentId",
        "businessName",
        "currency",
        "durationMinutes",
        "endsAt",
        "priceCents",
        "replayed",
        "serviceName",
        "startsAt",
        "status",
        "timezone",
      ].sort(),
    );
    const rows = await appointments();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.client_id)).size).toBe(1);
    const { rows: clients } = await db.query(
      "select first_name, last_name from public.clients where business_id = $1",
      [business.id],
    );
    expect(clients).toEqual([{ first_name: "Camille", last_name: "Martin" }]);
  });
});

describe("ambiguous retries", () => {
  it("a retry of the same request answers the same booking and writes nothing", async () => {
    const sent = body();
    const first = await (await post(sent)).json();
    const retry = await post(sent);
    expect(retry.status).toBe(200);
    const replayed = (await retry.json()).data.booking;
    expect(replayed).toEqual({ ...first.data.booking, replayed: true });

    expect(await appointments()).toHaveLength(1);
    const { rows } = await db.query(
      "select count(*)::int as count from public.email_events where business_id = $1",
      [business.id],
    );
    expect(rows[0]).toEqual({ count: 1 });
  });

  it("concurrent identical retries create one appointment", async () => {
    const sent = body();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post(sent)),
    );
    const bookings = await Promise.all(
      responses.map(async (response) => (await response.json()).data.booking),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200, 200, 200, 201,
    ]);
    expect(new Set(bookings.map((booking) => booking.appointmentId)).size).toBe(
      1,
    );
    expect(await appointments()).toHaveLength(1);
  });

  it("a retry is answered even once the slot is no longer bookable (blocked, or past the window)", async () => {
    const sent = body();
    expect((await post(sent)).status).toBe(201);
    await addException(business.id, "blocked", at("12:00"), at("13:00"));
    await db.query(
      "update public.business_settings set maximum_booking_advance_days = 1 where business_id = $1",
      [business.id],
    );
    const retry = await post(sent);
    expect(retry.status).toBe(200);
    expect((await retry.json()).data.booking.replayed).toBe(true);
  });

  it("the same request id with another command is refused, nothing written", async () => {
    const sent = body();
    expect((await post(sent)).status).toBe(201);
    for (const changed of [
      { startsAt: at("15:00") },
      { firstName: "Autre" },
      { email: "autre@example.test" },
      { phone: "07 00 00 00 00" },
    ]) {
      const response = await post({ ...sent, ...changed });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("idempotency_conflict");
    }
    expect(await appointments()).toHaveLength(1);
  });

  it("a request id is scoped to its business", async () => {
    const requestId = randomUUID();
    expect((await post(body({ requestId }))).status).toBe(201);
    const elsewhere = await post(
      body({ requestId, slug: other.slug, serviceId: otherService }),
    );
    expect(elsewhere.status).toBe(201);
    expect(await appointments()).toHaveLength(1);
    expect(await appointments(other.id)).toHaveLength(1);
  });

  it("requires a request id", async () => {
    const withoutId = body();
    delete withoutId.requestId;
    const response = await post(withoutId);
    expect(response.status).toBe(400);
    expect(Object.keys((await response.json()).error.fieldErrors)).toEqual([
      "requestId",
    ]);
    expect(await appointments()).toHaveLength(0);
  });
});

describe("one slot, many customers", () => {
  it("concurrent requests for the same slot: exactly one booking, the others slot_unavailable", async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        post(body(), `203.0.113.${index}-${randomUUID()}`),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    for (const response of responses.filter((r) => r.status === 409)) {
      expect((await response.json()).error.code).toBe("slot_unavailable");
    }
    expect(await appointments()).toHaveLength(1);
  });

  it("an outdated slot (taken, closed, in the past, off the grid) is refused", async () => {
    expect((await post(body())).status).toBe(201);
    await addException(
      business.id,
      "closed",
      at("00:00", dateInDays(17)),
      at("00:00", dateInDays(18)),
    );
    for (const startsAt of [
      at("10:00"), // taken
      at("10:30"), // overlaps the taken one
      at("12:00", dateInDays(17)), // closed day
      at("10:00", dateInDays(-1)), // past
      at("10:10"), // not on the 30-minute grid
      at("20:00"), // outside the hours
      at("10:00", dateInDays(200)), // beyond the booking window
    ]) {
      const response = await post(body({ startsAt }));
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("slot_unavailable");
    }
    expect(await appointments()).toHaveLength(1);
  });

  it("an inactive or foreign service is not bookable", async () => {
    const inactive = await createService(business.id, {
      name: "Ancienne",
      active: false,
    });
    for (const serviceId of [inactive, otherService, randomUUID()]) {
      const response = await post(body({ serviceId }));
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("service_not_found");
    }
    const unknown = await post(body({ slug: "nobody-here-123" }));
    expect(unknown.status).toBe(404);
    expect(await appointments()).toHaveLength(0);
    expect(await appointments(other.id)).toHaveLength(0);
  });

  it("invalid customer input is refused by the route and again by the database", async () => {
    const response = await post(
      body({ firstName: " ", email: "nope", phone: "abc" }),
    );
    expect(response.status).toBe(400);
    expect(
      Object.keys((await response.json()).error.fieldErrors).sort(),
    ).toEqual(["email", "firstName", "phone"]);
    expect(await appointments()).toHaveLength(0);
  });
});

describe("abuse limits", () => {
  it("5 new bookings per hour per address; replays do not count; other addresses are unaffected", async () => {
    const ip = `192.0.2.1-${randomUUID()}`;
    const first = body({ startsAt: at("09:00") });
    for (const time of ["09:00", "10:00", "11:00", "12:00", "13:00"]) {
      const sent = time === "09:00" ? first : body({ startsAt: at(time) });
      expect((await post(sent, ip)).status).toBe(201);
    }
    // A replay is still answered.
    expect((await post(first, ip)).status).toBe(200);

    const refused = await post(body({ startsAt: at("14:00") }), ip);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("rate_limited");

    expect(
      (await post(body({ startsAt: at("14:00") }), `${ip}-other`)).status,
    ).toBe(201);
    expect(await appointments()).toHaveLength(6);
  });

  it("10 new bookings per 24 hours per email in a business, whatever the address; same answer as the address limit", async () => {
    const email = `limit-${randomUUID().slice(0, 8)}@example.test`;
    const times = ["09:00", "10:00", "11:00", "12:00", "13:00"];
    const day = (index: number) => dateInDays(16 + Math.floor(index / 5));
    for (let index = 0; index < 10; index += 1) {
      const response = await post(
        body({ startsAt: at(times[index % 5]!, day(index)), email }),
        `203.0.113.9-${randomUUID()}`,
      );
      expect([index, response.status, (await response.json()).error]).toEqual([
        index,
        201,
        undefined,
      ]);
    }
    const refused = await post(
      body({ startsAt: at("15:00"), email: email.toUpperCase() }),
      `203.0.113.9-${randomUUID()}`,
    );
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toEqual({
      code: "rate_limited",
      message: "Trop de tentatives. Merci de réessayer dans quelques minutes.",
    });
    // Another business is another count.
    expect(
      (await post(body({ slug: other.slug, serviceId: otherService, email })))
        .status,
    ).toBe(201);
  });

  it("the log keeps hashes only", async () => {
    const email = `hash-${randomUUID().slice(0, 8)}@example.test`;
    expect((await post(body({ email }), "203.0.113.77")).status).toBe(201);
    const { rows } = await db.query<{ row: string }>(
      "select l::text as row from private.public_booking_log l where business_id = $1",
      [business.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).not.toContain(email);
    expect(rows[0]!.row).not.toContain("203.0.113.77");
  });
});
