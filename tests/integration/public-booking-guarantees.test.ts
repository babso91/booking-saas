import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as postBooking } from "@/app/api/bookings/route";
import { serverContactErrors } from "@/features/public-booking/client/contact";
import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { getPublicBusiness } from "@/features/businesses/data/public-business";
import { AppException } from "@/lib/errors";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  addException,
  anonClient,
  bookingClient,
  createBusiness,
  createProfessional,
  createService,
  db,
  dateInDays,
  env,
  everyDay,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// The public booking journey (PR #21) through the real route handler, the
// service-role call and PostgreSQL: the trusted ingress identity, abuse
// limits, idempotency of ambiguous retries, concurrency on one slot,
// existing customers, pseudonymous log and its retention, validation
// errors, isolation and what is (not) exposed. The booking engine itself is covered by public-booking*.test.ts,
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

const SECRET = "test-proxy-secret-0123456789abcdef0123456789";

// Addresses of this run only: the log outlives a run (limits over 24 h).
const RUN = [1, 2].map(() => Math.floor(Math.random() * 256));
/** An IPv4 address of this run. */
const v4 = (host: number) => `10.${RUN[0]}.${RUN[1]}.${host}`;
/** An IPv6 prefix (/48) of this run. */
const V6 = `2001:db8:${((RUN[0]! << 8) | RUN[1]!).toString(16)}`;

type Ingress = {
  /** The TCP peer address the trusted proxy writes (x-booking-client-ip). */
  ip?: string | null;
  /** The proxy secret it adds; null: a request that did not come through it. */
  secret?: string | null;
  /** Anything else the client sent (forged forwarding headers…). */
  headers?: Record<string, string>;
};

/**
 * A request as the trusted proxy forwards it: a fresh peer address per
 * call unless given (the network limits are tested on their own).
 */
function post(body: Body | string, ingress: Ingress = {}) {
  const headers: Record<string, string> = { ...ingress.headers };
  const ip = ingress.ip === undefined ? randomIp() : ingress.ip;
  const secret = ingress.secret === undefined ? SECRET : ingress.secret;
  if (ip !== null) headers["x-booking-client-ip"] = ip;
  if (secret !== null) headers["x-booking-proxy-secret"] = secret;
  return postBooking(
    new Request("http://localhost/api/bookings", {
      method: "POST",
      headers,
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
  process.env.BOOKING_PROXY_SECRET = SECRET;
  owner = await createProfessional("public-booking-guarantees");
});

beforeEach(async () => {
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
        post(body(), { ip: `203.0.113.${index + 10}` }),
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

async function logRows(businessId = business.id) {
  const { rows } = await db.query<{
    network_key: string | null;
    email_key: string;
    created_at: Date;
  }>(
    "select network_key, email_key, created_at from private.public_booking_log where business_id = $1 order by id",
    [businessId],
  );
  return rows;
}

const status = async (response: Response) =>
  [response.status, (await response.json()).error?.code ?? "ok"] as const;

// ---------------------------------------------------------------------------
// The trusted ingress: the caller never chooses its rate-limit identity
// ---------------------------------------------------------------------------

describe("client identity from the trusted ingress", () => {
  it("refuses every booking when no proxy secret is configured (fail closed, no shared bucket)", async () => {
    delete process.env.BOOKING_PROXY_SECRET;
    try {
      const response = await post(body(), {
        headers: { "x-forwarded-for": v4(7) },
      });
      expect(await status(response)).toEqual([503, "booking_unavailable"]);
    } finally {
      process.env.BOOKING_PROXY_SECRET = SECRET;
    }
    expect(await appointments()).toHaveLength(0);
  });

  it("refuses requests that did not come through the proxy, whatever forwarding headers they forge", async () => {
    for (const ingress of [
      // Direct access with the usual forwarding headers.
      {
        secret: null,
        ip: null,
        headers: { "x-forwarded-for": v4(7) },
      },
      { secret: null, ip: null, headers: { "x-real-ip": v4(7) } },
      // Direct access forging our own header.
      { secret: null, ip: v4(7) },
      // A guessed or empty secret.
      { secret: "guess", ip: v4(7) },
      { secret: `${SECRET}x`, ip: v4(7) },
      { secret: "", ip: v4(7) },
    ] as Ingress[]) {
      expect(await status(await post(body(), ingress))).toEqual([
        503,
        "booking_unavailable",
      ]);
    }
    expect(await appointments()).toHaveLength(0);
    expect(await logRows()).toHaveLength(0);
  });

  it("refuses a proxied request whose client address is missing or not one literal address", async () => {
    for (const ip of [
      null,
      "",
      "198.51.100.7, 10.0.0.1",
      "198.51.100.7:443",
      "[2001:db8::1]",
      "fe80::1%eth0",
      "localhost",
      "999.1.1.1",
      "unknown",
    ]) {
      expect(await status(await post(body(), { ip }))).toEqual([
        503,
        "booking_unavailable",
      ]);
    }
    expect(await appointments()).toHaveLength(0);
  });

  it("rotating x-forwarded-for / x-real-ip does not change the identity: the network limit still applies", async () => {
    const peer = v4(20);
    const results = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await post(
        body({ startsAt: at(`${String(9 + index).padStart(2, "0")}:00`) }),
        {
          ip: peer,
          headers: {
            "x-forwarded-for": `203.0.113.${index}`,
            "x-real-ip": `192.0.2.${index}`,
          },
        },
      );
      results.push(await status(response));
    }
    // 3 per network in one business, whatever the forged headers say.
    expect(results).toEqual([
      [201, "ok"],
      [201, "ok"],
      [201, "ok"],
      [429, "rate_limited"],
      [429, "rate_limited"],
      [429, "rate_limited"],
    ]);
    expect(await appointments()).toHaveLength(3);
  });

  it("an attacker cannot exhaust another visitor's quota by naming its address", async () => {
    const victim = v4(30);
    for (let index = 0; index < 5; index += 1) {
      await post(
        body({ startsAt: at(`${String(9 + index).padStart(2, "0")}:00`) }),
        {
          ip: `203.0.113.${50 + index}`,
          headers: {
            "x-forwarded-for": victim,
            "x-real-ip": victim,
            "x-booking-client-ip": victim,
          },
        },
      );
    }
    // The forged x-booking-client-ip was replaced by the proxy (the peer
    // address): the victim's network has booked nothing.
    const mine = await post(body({ startsAt: at("15:00") }), { ip: victim });
    expect(await status(mine)).toEqual([201, "ok"]);
  });

  it("IPv6: one /64 is one identity; another /64 is another; IPv4-mapped IPv6 is its IPv4", async () => {
    const inside = [
      `${V6}:1::1`,
      `${V6}:1:ffff:ffff:ffff:ffff`,
      `${V6}:0001::abcd`,
    ];
    for (const [index, ip] of inside.entries()) {
      expect(
        await status(
          await post(
            body({ startsAt: at(`${String(9 + index).padStart(2, "0")}:00`) }),
            { ip },
          ),
        ),
      ).toEqual([201, "ok"]);
    }
    expect(
      await status(
        await post(body({ startsAt: at("13:00") }), {
          ip: `${V6}:1::99`,
        }),
      ),
    ).toEqual([429, "rate_limited"]);
    expect(
      await status(
        await post(body({ startsAt: at("13:00") }), { ip: `${V6}:2::1` }),
      ),
    ).toEqual([201, "ok"]);

    const mapped = v4(40);
    for (const [index, ip] of [mapped, `::ffff:${mapped}`, mapped].entries()) {
      expect(
        await status(
          await post(body({ startsAt: at(`${14 + index}:00`) }), { ip }),
        ),
      ).toEqual([201, "ok"]);
    }
    expect(
      await status(
        await post(body({ startsAt: at("17:00") }), { ip: `::ffff:${mapped}` }),
      ),
    ).toEqual([429, "rate_limited"]);
  });
});

// ---------------------------------------------------------------------------
// Layered abuse limits
// ---------------------------------------------------------------------------

describe("abuse limits", () => {
  it("concurrent requests from one network: exactly the allowed number is booked", async () => {
    const ip = v4(50);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        post(
          body({ startsAt: at(`${String(9 + index).padStart(2, "0")}:00`) }),
          { ip },
        ),
      ),
    );
    const statuses = (await Promise.all(responses.map(status))).map(
      ([code]) => code,
    );
    expect(statuses.filter((code) => code === 201)).toHaveLength(3);
    expect(statuses.filter((code) => code === 429)).toHaveLength(5);
    expect(await appointments()).toHaveLength(3);
  });

  it("several family members from one network: 3 in a business, more elsewhere; 5 per hour in all", async () => {
    const ip = v4(60);
    const third = await createBusiness(owner.userId);
    const thirdService = await createService(third.id, { name: "Soin" });
    await setWeeklyHours(third.id, everyDay(["09:00", "18:00"]));

    const outcomes = [];
    for (const [index, target] of [
      [business.slug, service],
      [business.slug, service],
      [business.slug, service],
      [other.slug, otherService],
      [other.slug, otherService],
      [third.slug, thirdService],
    ].entries()) {
      outcomes.push(
        await status(
          await post(
            body({
              slug: target[0],
              serviceId: target[1],
              startsAt: at(`${String(9 + index).padStart(2, "0")}:00`),
              firstName: `Membre ${index}`,
            }),
            { ip },
          ),
        ),
      );
    }
    expect(outcomes.map(([code]) => code)).toEqual([
      201, 201, 201, 201, 201, 429,
    ]);
  });

  it("email aliases are distinct addresses, never merged; the network limits still bound them", async () => {
    const ip = v4(70);
    const outcomes = [];
    for (const [index, email] of [
      "camille+1@example.test",
      "camille+2@example.test",
      "c.amille@example.test",
      "camille+3@example.test",
    ].entries()) {
      outcomes.push(
        await status(
          await post(
            body({
              startsAt: at(`${String(9 + index).padStart(2, "0")}:00`),
              email,
            }),
            { ip },
          ),
        ),
      );
    }
    expect(outcomes.map(([code]) => code)).toEqual([201, 201, 201, 429]);
    const { rows } = await db.query(
      "select email from public.clients where business_id = $1 order by email",
      [business.id],
    );
    expect(rows.map((row) => row.email)).toEqual([
      "c.amille@example.test",
      "camille+1@example.test",
      "camille+2@example.test",
    ]);
  });

  it("15 per 24 hours per network, all businesses (fixed clock)", async () => {
    // Its own network: the entries of this fixed clock outlive one run.
    const ip = randomIp();
    const targets: { slug: string; service: string }[] = [];
    for (let index = 0; index < 6; index += 1) {
      const b = await createBusiness(owner.userId, {
        settings: { minimum_booking_notice_minutes: 0 },
      });
      const s = await createService(b.id, { name: "Soin" });
      await setWeeklyHours(b.id, everyDay(["00:00", "24:00"]));
      targets.push({ slug: b.slug, service: s });
    }
    const base = new Date(`${dateInDays(20)}T06:00:00Z`).getTime();
    const book = (index: number, minutesLater: number) =>
      db
        .query(
          `select appointment_id from private.create_public_booking_at(
             $1::timestamptz, $2, $3, $4::timestamptz, 'Léa', $5, null, null,
             gen_random_uuid(), $6::inet)`,
          [
            new Date(base + minutesLater * 60_000).toISOString(),
            targets[Math.floor(index / 3)]!.slug,
            targets[Math.floor(index / 3)]!.service,
            new Date(base + (24 + index) * 3_600_000).toISOString(),
            `n${index}@example.test`,
            ip,
          ],
        )
        .then(
          () => "ok",
          (error: Error) => error.message,
        );
    const outcomes = [];
    // 5 per hour, every hour: 15 in three hours, then refused.
    for (let index = 0; index < 16; index += 1) {
      outcomes.push(await book(index, Math.floor(index / 5) * 61));
    }
    expect(outcomes.slice(0, 15)).toEqual(Array(15).fill("ok"));
    expect(outcomes[15]).toBe("rate_limited");
  });

  it("10 per 24 hours per email in a business, whatever the network; same answer as the network limits", async () => {
    const email = `limit-${randomUUID().slice(0, 8)}@example.test`;
    const times = ["09:00", "10:00", "11:00", "12:00", "13:00"];
    const day = (index: number) => dateInDays(16 + Math.floor(index / 5));
    for (let index = 0; index < 10; index += 1) {
      const response = await post(
        body({ startsAt: at(times[index % 5]!, day(index)), email }),
      );
      expect([index, ...(await status(response))]).toEqual([index, 201, "ok"]);
    }
    const refused = await post(
      body({ startsAt: at("15:00"), email: email.toUpperCase() }),
    );
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toEqual({
      code: "rate_limited",
      message: "Trop de tentatives. Merci de réessayer dans quelques minutes.",
    });
    expect(
      (await post(body({ slug: other.slug, serviceId: otherService, email })))
        .status,
    ).toBe(201);
  });

  it("replays never count; another network is unaffected", async () => {
    const ip = v4(90);
    const first = body({ startsAt: at("09:00") });
    expect((await post(first, { ip })).status).toBe(201);
    for (let index = 0; index < 4; index += 1) {
      expect((await post(first, { ip })).status).toBe(200);
    }
    expect((await post(body({ startsAt: at("10:00") }), { ip })).status).toBe(
      201,
    );
    expect(
      (await post(body({ startsAt: at("11:00") }), { ip: v4(91) })).status,
    ).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Existing customers: linked, never changed by an unverified visitor
// ---------------------------------------------------------------------------

describe("existing customers", () => {
  async function existingClient(fields: {
    firstName: string;
    lastName: string | null;
    phone: string | null;
  }) {
    const email = `known-${randomUUID().slice(0, 8)}@example.test`;
    const { rows } = await db.query<{ id: string }>(
      `insert into public.clients (business_id, first_name, last_name, email, phone, internal_notes)
       values ($1, $2, $3, $4, $5, 'Allergie au latex') returning id`,
      [business.id, fields.firstName, fields.lastName, email, fields.phone],
    );
    return { id: rows[0]!.id, email };
  }

  async function record(id: string) {
    const { rows } = await db.query(
      "select first_name, last_name, email, phone, version from public.clients where id = $1",
      [id],
    );
    return rows[0];
  }

  it("a visitor using the email of a customer with empty fields cannot fill them", async () => {
    const known = await existingClient({
      firstName: "Camille",
      lastName: null,
      phone: null,
    });
    const before = await record(known.id);
    const response = await post(
      body({
        email: known.email.toUpperCase(),
        firstName: "Intrus",
        lastName: "Usurpateur",
        phone: "06 66 66 66 66",
      }),
    );
    expect(response.status).toBe(201);
    expect(await record(known.id)).toEqual(before);
    // The booking keeps what the visitor typed, on the appointment only.
    const { rows } = await db.query(
      `select client_id, client_first_name_snapshot, client_last_name_snapshot, client_phone_snapshot
       from public.appointments where business_id = $1`,
      [business.id],
    );
    expect(rows).toEqual([
      {
        client_id: known.id,
        client_first_name_snapshot: "Intrus",
        client_last_name_snapshot: "Usurpateur",
        client_phone_snapshot: "06 66 66 66 66",
      },
    ]);
  });

  it("a customer with complete fields is left exactly as she is", async () => {
    const known = await existingClient({
      firstName: "Camille",
      lastName: "Roux",
      phone: "06 12 12 12 12",
    });
    const before = await record(known.id);
    expect(
      (
        await post(
          body({
            email: known.email,
            lastName: "Autre",
            phone: "07 00 00 00 00",
          }),
        )
      ).status,
    ).toBe(201);
    expect(await record(known.id)).toEqual(before);
  });

  it("the answer is the same whether the email is known or not, and exposes nothing of the record", async () => {
    const known = await existingClient({
      firstName: "Camille",
      lastName: null,
      phone: null,
    });
    const answers = [];
    for (const [index, email] of [
      known.email,
      "never-seen@example.test",
    ].entries()) {
      const response = await post(
        body({
          email,
          startsAt: at(`${String(9 + index).padStart(2, "0")}:00`),
        }),
      );
      expect(response.status).toBe(201);
      answers.push((await response.json()).data.booking);
    }
    const shape = (answer: Record<string, unknown>) => ({
      ...answer,
      appointmentId: "*",
      startsAt: "*",
      endsAt: "*",
    });
    expect(shape(answers[0])).toEqual(shape(answers[1]));
    expect(JSON.stringify(answers)).not.toMatch(/latex|Camille|known-/);
  });

  it("a legitimate repeat booking links the same record; a new email creates one; other businesses are separate", async () => {
    const email = `repeat-${randomUUID().slice(0, 8)}@example.test`;
    expect((await post(body({ email, startsAt: at("09:00") }))).status).toBe(
      201,
    );
    expect((await post(body({ email, startsAt: at("11:00") }))).status).toBe(
      201,
    );
    expect(
      (await post(body({ email, slug: other.slug, serviceId: otherService })))
        .status,
    ).toBe(201);
    const ids = new Set((await appointments()).map((row) => row.client_id));
    expect(ids.size).toBe(1);
    const { rows } = await db.query(
      "select business_id, last_name, phone from public.clients where email = $1 order by business_id",
      [email],
    );
    expect(rows).toHaveLength(2);
    // A new customer is created with what she typed.
    expect(rows.every((row) => row.last_name === "Martin")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The log: keyed pseudonyms, bounded retention
// ---------------------------------------------------------------------------

describe("booking log", () => {
  it("stores keyed HMACs: stable for one identity, never the plain or unsalted hash", async () => {
    const ip = "203.0.113.77";
    const email = `hash-${randomUUID().slice(0, 8)}@example.test`;
    expect(
      (await post(body({ email, startsAt: at("09:00") }), { ip })).status,
    ).toBe(201);
    expect(
      (await post(body({ email, startsAt: at("10:00") }), { ip })).status,
    ).toBe(201);
    const rows = await logRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.network_key).toBe(rows[1]!.network_key);
    expect(rows[0]!.email_key).toBe(rows[1]!.email_key);
    const { rows: plain } = await db.query(
      `select encode(sha256(convert_to($1, 'UTF8')), 'hex') as ip,
              encode(sha256(convert_to('network:' || $1, 'UTF8')), 'hex') as ip2,
              encode(sha256(convert_to($2, 'UTF8')), 'hex') as email`,
      [ip, email],
    );
    const text = JSON.stringify(rows);
    for (const value of [
      ip,
      email,
      plain[0].ip,
      plain[0].ip2,
      plain[0].email,
    ]) {
      expect(text).not.toContain(value);
    }
    expect(rows[0]!.network_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the HMAC key is unreachable from every API role, and rotating it changes the pseudonyms", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const connection = await db.connect();
      try {
        await connection.query("begin");
        await connection.query(`set local role ${role}`);
        await expect(
          connection.query("select key from private.abuse_hmac_keys"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await connection.query("rollback");
        connection.release();
      }
    }
    const { rows: before } = await db.query(
      "select private.abuse_key('network:198.51.100.1') as key",
    );
    const connection = await db.connect();
    try {
      await connection.query("begin");
      await connection.query(
        "insert into private.abuse_hmac_keys default values",
      );
      const { rows: after } = await connection.query(
        "select private.abuse_key('network:198.51.100.1') as key",
      );
      expect(after[0].key).not.toBe(before[0].key);
    } finally {
      await connection.query("rollback");
      connection.release();
    }
  });

  it("entries older than 48 hours are purged, in bounded batches; recent ones and idempotency are kept", async () => {
    const replayed = body();
    expect((await post(replayed)).status).toBe(201);
    await db.query(
      `insert into private.public_booking_log (business_id, network_key, email_key, created_at)
       select $1, md5(i::text), md5(i::text), now() - interval '3 days' - i * interval '1 second'
       from generate_series(1, 150) i`,
      [business.id],
    );
    await db.query(
      `insert into private.public_booking_log (business_id, network_key, email_key, created_at)
       values ($1, 'recent', 'recent', now() - interval '47 hours')`,
      [business.id],
    );
    const count = async () =>
      (
        await db.query(
          "select count(*) filter (where created_at < now() - interval '48 hours')::int as old, count(*)::int as total from private.public_booking_log where business_id = $1",
          [business.id],
        )
      ).rows[0];

    expect(await count()).toEqual({ old: 150, total: 152 });
    // One booking purges at most 100 old entries.
    expect((await post(body({ startsAt: at("14:00") }))).status).toBe(201);
    expect(await count()).toEqual({ old: 50, total: 53 });
    // The scheduled purge does the rest; recent entries stay.
    const { rows } = await db.query(
      "select private.purge_public_booking_log(now() - interval '48 hours') as deleted",
    );
    expect(rows[0]).toEqual({ deleted: 50 });
    expect(await count()).toEqual({ old: 0, total: 3 });
    // The committed booking is still replayed: idempotency is not the log.
    const replay = await post(replayed);
    expect(replay.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Validation errors raised by PostgreSQL become field errors
// ---------------------------------------------------------------------------

describe("database validation errors", () => {
  // Past the route's schema (defense in depth): what the database says must
  // reach the form as a field error, the field the customer can correct.
  it.each([
    ["firstName", { firstName: "   " }],
    ["firstName", { firstName: "x".repeat(121) }],
    ["lastName", { lastName: "x".repeat(121) }],
    ["email", { email: "not-an-email" }],
    ["phone", { phone: "abc" }],
  ])(
    "%s → validation_error with fieldErrors.%s, back to the contact form",
    async (field, invalid) => {
      const input = {
        slug: business.slug,
        serviceId: service,
        startsAt: at("10:00"),
        firstName: "Léa",
        email: "lea@example.test",
        requestId: randomUUID(),
        ...invalid,
      };
      const error = await createPublicBooking(
        bookingClient(),
        input,
        randomIp(),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AppException);
      const appError = (error as AppException).toAppError();
      expect(appError.code).toBe("validation_error");
      expect(Object.keys(appError.fieldErrors ?? {})).toEqual([field]);
      // What the booking flow does with it: this field, on the contact step.
      expect(Object.keys(serverContactErrors(appError.fieldErrors))).toEqual([
        field,
      ]);
      expect(await appointments()).toHaveLength(0);
    },
  );

  it("a missing start is a validation error on startsAt, not on a contact field", async () => {
    const { error } = await bookingClient().rpc("create_public_booking", {
      p_slug: business.slug,
      p_service_id: service,
      p_starts_at: null as unknown as string,
      p_first_name: "Léa",
      p_email: "lea@example.test",
      p_request_id: randomUUID(),
      p_client_ip: randomIp(),
    });
    expect(error).toMatchObject({
      message: "invalid_starts_at",
      hint: "startsAt",
    });
  });
});

describe("the public business", () => {
  it("answers today's date in the business time zone, by the database's clock", async () => {
    const profile = await getPublicBusiness(anonClient(), business.slug);
    const { rows } = await db.query(
      "select (now() at time zone 'Europe/Paris')::date::text as today",
    );
    expect(profile?.today).toBe(rows[0].today);
  });
});
