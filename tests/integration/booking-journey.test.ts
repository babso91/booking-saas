import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postBooking } from "@/app/api/bookings/route";
import { POST as postCancel } from "@/app/api/client-hub/businesses/[businessId]/appointments/[appointmentId]/cancel/route";
import { GET as getHubAppointment } from "@/app/api/client-hub/businesses/[businessId]/appointments/[appointmentId]/route";
import { GET as getRescheduleSlots } from "@/app/api/client-hub/businesses/[businessId]/appointments/[appointmentId]/reschedule-slots/route";
import { GET as getHubAppointments } from "@/app/api/client-hub/businesses/[businessId]/appointments/route";
import { GET as getHubLoyalty } from "@/app/api/client-hub/businesses/[businessId]/loyalty/route";
import { GET as getHubMe } from "@/app/api/client-hub/me/route";
import { POST as postCode } from "@/app/api/client-hub/session/code/route";
import { POST as postVerify } from "@/app/api/client-hub/session/verify/route";
import { GET as getAvailability } from "@/app/api/public/businesses/[slug]/availability/route";
import { GET as getPublicBusiness } from "@/app/api/public/businesses/[slug]/route";
import { runEmailOutbox } from "@/features/notifications/data/worker";
import type { ConfiguredTransport } from "@/features/notifications/transport";
import { MemoryTransport } from "@/features/notifications/transport/memory";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  bookingClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  env,
  everyDay,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// The tester's journey, end to end on the real routes (Higani backlog,
// lot 1: points 53, 57, 71, 72, 78, 151, 203, 204): a guest books from the
// public page of business A with an option, the server holds the slot and
// the quote, the confirmation email carries two links, and the "manage or
// cancel" link brings her, after a code, to that very appointment, which she
// cancels within A's policy. Business B checks the isolation.
//
// Case (kept fixed so a failure is readable):
// - time zone Europe/Paris, slots every 30 min, notice 60 min, horizon 21 days;
// - usual hours 09:00–18:00 every day; D1 = today + 3 (usual);
//   D2 = today + 4 opens 13:00–16:00 only (date hours); D3 = today + 5 closed;
// - « Pose » 60 min, 60,00 € ; required question « Effet »: « Classique »
//   (nothing added) or « Volume mixte » (+20,00 €, +30 min);
// - online cancellation up to 24 h before the start (A's policy).

let transport: MemoryTransport;
let configured: ConfiguredTransport | null;
let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/features/notifications/transport", () => ({
  getEmailTransport: () => configured,
}));
vi.mock("@/features/notifications/data/kick", () => ({
  kickEmailOutbox: () => undefined,
}));
vi.mock("@/features/calendar/data/outbound-kick", () => ({
  kickCalendarOutbound: () => undefined,
}));

const SECRET = "journey-test-proxy-secret-0123456789abcdef";
const BASE = "http://localhost:3000";
const TZ = "Europe/Paris";
const FROM = "Higani <noreply@test.local>";

const localDate = (daysFromToday: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(Date.now() + daysFromToday * 86_400_000),
  );
const D1 = localDate(3);
const D2 = localDate(4);
const D3 = localDate(5);
// A usual day of its own for the access cases.
const D4 = localDate(6);
const D5 = localDate(7);
const D6 = localDate(8);

function request(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; ip?: string } = {},
) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: BASE,
    "x-booking-proxy-secret": SECRET,
    "x-booking-client-ip": options.ip ?? randomIp(),
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  return new NextRequest(new URL(path, BASE), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
const params = <T extends object>(value: T) => ({
  params: Promise.resolve(value),
});
async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

type Slot = { startsAt: string; localStartsAt: string };
type Quote = { priceCents: number; durationMinutes: number; currency: string };

let ownerA: Professional;
let ownerB: Professional;
let A: TestBusiness;
let B: TestBusiness;
let serviceA: string;
let serviceB: string;
let volume: string;
let classic: string;

async function availability(
  business: TestBusiness,
  serviceId: string,
  date: string,
  options: { choices?: string[]; through?: string } = {},
) {
  const query = new URLSearchParams({ serviceId, date });
  const choices = options.choices ?? (business === A ? [classic] : []);
  if (choices.length) query.set("optionChoiceIds", choices.join(","));
  if (options.through) query.set("through", options.through);
  return json(
    await getAvailability(
      request(
        "GET",
        `/api/public/businesses/${business.slug}/availability?${query}`,
      ),
      params({ slug: business.slug }),
    ),
  );
}
const times = (slots: Slot[]) =>
  slots.map((s) => s.localStartsAt.slice(11, 16));

function book(input: {
  startsAt: string;
  email: string;
  requestId?: string;
  choices?: string[];
  quote?: Quote;
  ip?: string;
}) {
  return postBooking(
    request("POST", "/api/bookings", {
      ip: input.ip,
      body: {
        slug: A.slug,
        serviceId: serviceA,
        startsAt: input.startsAt,
        firstName: "Inès",
        email: input.email,
        requestId: input.requestId ?? randomUUID(),
        optionChoiceIds: input.choices ?? [classic],
        ...(input.quote
          ? {
              expectedPriceCents: input.quote.priceCents,
              expectedDurationMinutes: input.quote.durationMinutes,
            }
          : {}),
      },
    }),
  );
}

const deliver = (businessId: string) =>
  runEmailOutbox(
    { admin: bookingClient(), transport, from: FROM, appUrl: BASE },
    { businessId },
  );
const mailTo = (address: string) =>
  transport.sent.filter((email) => email.to === address);

/** Her code login, as from the sign-in page: the session cookie. */
async function signIn(email: string) {
  const asked = await json(
    await postCode(
      request("POST", "/api/client-hub/session/code", { body: { email } }),
    ),
  );
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  const code = mailTo(email).at(-1)!.subject.slice(0, 8);
  const verified = await postVerify(
    request("POST", "/api/client-hub/session/verify", {
      body: { challengeId: asked.body.data.challengeId, email, code },
    }),
  );
  expect(verified.status).toBe(200);
  return verified.headers
    .get("set-cookie")!
    .match(/(__Host-client_hub_s_[0-9a-f-]{36}=[0-9a-f]{64})/)![1]!;
}
const hubRead = async (cookie: string, businessId: string, id: string) =>
  json(
    await getHubAppointment(
      request(
        "GET",
        `/api/client-hub/businesses/${businessId}/appointments/${id}`,
        { cookie },
      ),
      params({ businessId, appointmentId: id }),
    ),
  );
const hubCancel = async (
  cookie: string,
  businessId: string,
  id: string,
  expectedVersion: number,
  requestId = randomUUID(),
) =>
  json(
    await postCancel(
      request(
        "POST",
        `/api/client-hub/businesses/${businessId}/appointments/${id}/cancel`,
        { cookie, body: { expectedVersion, requestId } },
      ),
      params({ businessId, appointmentId: id }),
    ),
  );

beforeAll(async () => {
  process.env.BOOKING_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;

  ownerA = await createProfessional("journey-a");
  ownerB = await createProfessional("journey-b");
  const settings = {
    slot_interval_minutes: 30,
    buffer_minutes: 0,
    minimum_booking_notice_minutes: 60,
    maximum_booking_advance_days: 21,
  };
  A = await createBusiness(ownerA.userId, { timezone: TZ, settings });
  B = await createBusiness(ownerB.userId, { timezone: TZ, settings });
  for (const business of [A, B]) {
    await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
  }
  serviceA = await createService(A.id, {
    name: "Pose",
    durationMinutes: 60,
    priceCents: 6000,
  });
  serviceB = await createService(B.id, { name: "Coupe", durationMinutes: 30 });
  const { rows } = await db.query<{ id: string }>(
    `with o as (
       insert into public.service_options (business_id, service_id, question)
       values ($1, $2, 'Effet') returning id
     )
     insert into public.service_option_choices
       (business_id, option_id, label, price_delta_cents, duration_delta_minutes)
     select $1, o.id, label, price, minutes
     from o, (values ('Classique', 0, 0, 1), ('Volume mixte', 2000, 30, 2)) c(label, price, minutes, rank)
     order by rank returning id`,
    [A.id, serviceA],
  );
  classic = rows[0]!.id;
  volume = rows[1]!.id;
  // D2: one exceptional range; D3: closed all day (local midnight to midnight).
  await db.query(
    "insert into public.business_date_hours (business_id, date, starts_at, ends_at) values ($1, $2, '13:00', '16:00')",
    [A.id, D2],
  );
  await db.query(
    `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
     values ($1, 'closed', ($2::date)::timestamp at time zone $3, ($2::date + 1)::timestamp at time zone $3)`,
    [A.id, D3, TZ],
  );
  sessionClient = ownerA.client;
  const policy = await ownerA.client.rpc(
    "set_booking_policy" as never,
    {
      p_business_id: A.id,
      p_cancellation_lead_minutes: 24 * 60,
      p_reschedule_lead_minutes: null,
    } as never,
  );
  expect(policy.error).toBeNull();
});

beforeEach(() => {
  transport = new MemoryTransport();
  configured = { transport, from: FROM };
});

describe("points 57 and 203: the hours she can really book", () => {
  it("a usual day, an exceptional day and a closed day, with the option's length", async () => {
    const usual = await availability(A, serviceA, D1);
    expect(usual.status).toBe(200);
    expect(usual.body.data.timezone).toBe(TZ);
    expect(times(usual.body.data.slots).at(0)).toBe("09:00");
    expect(times(usual.body.data.slots).at(-1)).toBe("17:00");

    // 90 min with the option: the last slot still ends by 18:00.
    const longer = await availability(A, serviceA, D1, { choices: [volume] });
    expect(longer.body.data.quote).toMatchObject({
      priceCents: 8000,
      durationMinutes: 90,
      currency: "EUR",
    });
    expect(times(longer.body.data.slots).at(-1)).toBe("16:30");

    const exceptional = await availability(A, serviceA, D2, {
      choices: [volume],
    });
    expect(times(exceptional.body.data.slots)).toEqual([
      "13:00",
      "13:30",
      "14:00",
      "14:30",
    ]);
    expect((await availability(A, serviceA, D3)).body.data.slots).toEqual([]);
  });

  it("several days at once tell the same story as each day alone", async () => {
    const calendar = await availability(A, serviceA, D1, {
      choices: [volume],
      through: D3,
    });
    expect(calendar.status).toBe(200);
    const days = calendar.body.data.days as { date: string; slots: Slot[] }[];
    expect(days.map((d) => d.date)).toEqual([D1, D2, D3]);
    for (const day of days) {
      const alone = await availability(A, serviceA, day.date, {
        choices: [volume],
      });
      expect(day.slots.map((s) => new Date(s.startsAt).getTime())).toEqual(
        (alone.body.data.slots as Slot[]).map((s) =>
          new Date(s.startsAt).getTime(),
        ),
      );
    }
  });

  it("the notice and the horizon: nothing too soon, nothing beyond 21 days", async () => {
    const today = await availability(A, serviceA, localDate(0));
    const earliest = Date.now() + 60 * 60_000;
    for (const slot of today.body.data.slots as Slot[]) {
      expect(new Date(slot.startsAt).getTime()).toBeGreaterThanOrEqual(
        earliest - 1000,
      );
    }
    expect(
      (await availability(A, serviceA, localDate(20))).body.data.slots.length,
    ).toBeGreaterThan(0);
    expect(
      (await availability(A, serviceA, localDate(23))).body.data.slots,
    ).toEqual([]);
  });
});

describe("the journey: book, confirm, manage, cancel", () => {
  const email = `ines-${randomUUID().slice(0, 8)}@client.test`;
  let appointmentId: string;
  let slot: Slot;
  let quote: Quote;

  it("point 53: a guest books with the option at the quoted price, filed in A's CRM", async () => {
    const shown = await availability(A, serviceA, D1, { choices: [volume] });
    quote = shown.body.data.quote;
    slot = (shown.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === "10:00",
    )!;
    const requestId = randomUUID();
    const created = await json(
      await book({
        startsAt: slot.startsAt,
        email,
        requestId,
        choices: [volume],
        quote,
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    appointmentId = created.body.data.booking.appointmentId;

    const { rows } = await db.query(
      `select a.business_id, a.status, a.starts_at, a.ends_at, a.price_cents_snapshot,
              a.duration_minutes_snapshot, a.client_email_snapshot, a.options_snapshot,
              c.business_id as client_business, c.email as client_email
       from public.appointments a join public.clients c on c.id = a.client_id
       where a.id = $1`,
      [appointmentId],
    );
    expect(rows[0]).toMatchObject({
      business_id: A.id,
      status: "confirmed",
      price_cents_snapshot: 8000,
      duration_minutes_snapshot: 90,
      client_email_snapshot: email,
      client_business: A.id,
      client_email: email,
    });
    expect(new Date(rows[0].starts_at).toISOString()).toBe(slot.startsAt);
    expect(
      new Date(rows[0].ends_at).getTime() -
        new Date(rows[0].starts_at).getTime(),
    ).toBe(90 * 60_000);
    expect(JSON.stringify(rows[0].options_snapshot)).toContain("Volume mixte");
    // Nothing in B.
    expect(
      (
        await db.query(
          "select count(*)::int as n from public.clients where business_id = $1 and email = $2",
          [B.id, email],
        )
      ).rows[0].n,
    ).toBe(0);

    // Her agenda (the professional's own session) shows it.
    const agenda = await ownerA.client
      .from("appointments")
      .select("id, status")
      .eq("id", appointmentId);
    expect(agenda.data).toEqual([{ id: appointmentId, status: "confirmed" }]);

    // Point 72: the same request again (answer lost) is the same booking.
    const replay = await json(
      await book({
        startsAt: slot.startsAt,
        email,
        requestId,
        choices: [volume],
        quote,
      }),
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.booking.appointmentId).toBe(appointmentId);
    expect(
      (
        await db.query(
          "select count(*)::int as n from public.appointments where business_id = $1 and client_email_snapshot = $2",
          [A.id, email],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("point 71: two customers on the last copy of a slot, one booking, the other told why", async () => {
    const shown = await availability(A, serviceA, D1);
    const contested = (shown.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === "14:00",
    )!;
    const [x, y] = await Promise.all(
      ["ana", "bea"].map(async (who) =>
        json(
          await book({
            startsAt: contested.startsAt,
            email: `${who}-${randomUUID().slice(0, 6)}@client.test`,
          }),
        ),
      ),
    );
    const statuses = [x!.status, y!.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = x!.status === 409 ? x! : y!;
    expect(loser.body.error.code).toBe("slot_unavailable");
    // Read again, the slot is gone; another hour books with the same contact.
    const after = await availability(A, serviceA, D1);
    expect(times(after.body.data.slots)).not.toContain("14:00");
    expect(times(after.body.data.slots)).not.toContain("13:30");
    const other = (after.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === "15:30",
    )!;
    expect(
      (await book({ startsAt: other.startsAt, email: "bea-retry@client.test" }))
        .status,
    ).toBe(201);
  });

  it("point 151: one confirmation after the retry, its price, local time and two links", async () => {
    await deliver(A.id);
    const sent = mailTo(email);
    expect(sent).toHaveLength(1);
    const [confirmation] = sent;
    expect(confirmation!.text).toContain("80,00");
    expect(confirmation!.text).toMatch(/Prix : 80,00\s€/u);
    expect(confirmation!.text).toContain("Durée : 1 h 30");
    expect(confirmation!.text).toMatch(/Date : \w+ \d+ \w+ \d{4} à 10 h/);
    expect(confirmation!.text).toContain("(Europe/Paris)");
    const manage = `${BASE}/espace/connexion?next=${encodeURIComponent(
      `/espace/${A.id}/rendez-vous/${appointmentId}`,
    )}`;
    expect(confirmation!.text).toContain(manage);
    expect(confirmation!.text).toContain(`${BASE}/b/${A.slug}`);
    // Delivered again later: nothing new for her.
    await deliver(A.id);
    expect(mailTo(email)).toHaveLength(1);
  });

  it("point 151: a transport failure is retried, then sent once", async () => {
    const shown = await availability(A, serviceA, D1);
    const at = (shown.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === "11:30",
    )!;
    const address = `retry-${randomUUID().slice(0, 6)}@client.test`;
    expect((await book({ startsAt: at.startsAt, email: address })).status).toBe(
      201,
    );
    transport.failNext("provider_unavailable", "retry");
    expect(await deliver(A.id)).toMatchObject({ retried: 1 });
    expect(mailTo(address)).toHaveLength(0);
    await db.query(
      `update public.email_events set next_attempt_at = now() - interval '1 second'
       where business_id = $1 and status = 'pending' and next_attempt_at is not null`,
      [A.id],
    );
    await deliver(A.id);
    expect(mailTo(address)).toHaveLength(1);
  });

  it("point 78: the link of the email brings her, after a code, to this very appointment", async () => {
    const cookie = await signIn(email);
    const read = await hubRead(cookie, A.id, appointmentId);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data).toMatchObject({
      id: appointmentId,
      status: "confirmed",
      actions: { cancel: { allowed: true } },
    });
    // Her session sees this appointment, never B's nor another customer's.
    const stranger = await createClientRecord(A.id, "autre@client.test");
    const { rows } = await db.query<{ id: string }>(
      `insert into public.appointments (business_id, client_id, service_id, starts_at, ends_at,
         status, service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot,
         client_email_snapshot)
       values ($1, $2, $3, now() + interval '4 days', now() + interval '4 days 1 hour',
         'confirmed', 'Pose', 60, 6000, 'autre@client.test') returning id`,
      [A.id, stranger, serviceA],
    );
    expect((await hubRead(cookie, A.id, rows[0]!.id)).status).toBe(404);
    expect((await hubRead(cookie, B.id, appointmentId)).status).toBe(404);

    // This appointment only: not her record, its list, its loyalty, nor
    // the business in her space (those still need the professional's grant).
    const me = await json(
      await getHubMe(request("GET", "/api/client-hub/me", { cookie })),
    );
    expect(me.status).toBe(200);
    expect(me.body.data.businesses).toEqual([]);
    const list = await getHubAppointments(
      request(
        "GET",
        `/api/client-hub/businesses/${A.id}/appointments?scope=upcoming`,
        {
          cookie,
        },
      ),
      params({ businessId: A.id }),
    );
    expect(list.status).toBe(404);
    const loyalty = await getHubLoyalty(
      request("GET", `/api/client-hub/businesses/${A.id}/loyalty`, { cookie }),
      params({ businessId: A.id }),
    );
    expect(loyalty.status).toBe(404);
  });

  it("point 78: she cancels within the policy; the time is free again, the reminder dropped", async () => {
    const cookie = await signIn(email);
    const before = await hubRead(cookie, A.id, appointmentId);
    const cancelled = await hubCancel(
      cookie,
      A.id,
      appointmentId,
      before.body.data.actions.version,
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");

    const agenda = await ownerA.client
      .from("appointments")
      .select("status")
      .eq("id", appointmentId)
      .single();
    expect(agenda.data?.status).toBe("cancelled");
    const after = await availability(A, serviceA, D1, { choices: [volume] });
    expect(times(after.body.data.slots)).toContain("10:00");

    // The reminder still queued never leaves; she is told it is cancelled.
    const { rows } = await db.query<{ type: string; status: string }>(
      "select type, status from public.email_events where appointment_id = $1 order by created_at",
      [appointmentId],
    );
    expect(rows.find((r) => r.type === "appointment_reminder")?.status).toBe(
      "cancelled",
    );
    await deliver(A.id);
    expect(
      mailTo(email)
        .map((m) => m.subject)
        .join(" "),
    ).toMatch(/annul/i);

    // The link opened again: the same appointment, cancelled, no action.
    const reopened = await hubRead(await signIn(email), A.id, appointmentId);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({
      id: appointmentId,
      status: "cancelled",
      actions: null,
    });
  });
});

describe("point 78: who may manage it from the email", () => {
  /** A guest's booking at `time` on `date`; its emails not delivered yet. */
  async function booked(address: string, time: string, date = D4) {
    const shown = await availability(A, serviceA, date);
    const at = (shown.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === time,
    )!;
    const created = await json(
      await book({ startsAt: at.startsAt, email: address }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.data.booking.appointmentId as string;
  }
  /** The same, its booking confirmation accepted by the provider. */
  async function emailed(address: string, time: string, date = D4) {
    const id = await booked(address, time, date);
    await deliver(A.id);
    expect(mailTo(address)).toHaveLength(1);
    return id;
  }
  const sentOf = async (id: string) =>
    (
      await db.query<{ type: string; status: string; submitted: boolean }>(
        `select type, status, first_submitted_at is not null as submitted
         from public.email_events where appointment_id = $1 order by created_at`,
        [id],
      )
    ).rows;
  const fresh = (label: string) =>
    `${label}-${randomUUID().slice(0, 6)}@client.test`;
  const clientOf = async (id: string) =>
    (
      await db.query<{ client_id: string; version: number }>(
        "select client_id, version from public.appointments where id = $1",
        [id],
      )
    ).rows[0]!;

  it("no email of this appointment sent to her address: a login shows nothing", async () => {
    const address = fresh("jamais");
    const shown = await availability(A, serviceA, D4);
    const at = (shown.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === "17:00",
    )!;
    const created = await json(
      await book({ startsAt: at.startsAt, email: address }),
    );
    // The confirmation is still in the outbox (never delivered).
    const cookie = await signIn(address);
    expect(
      (await hubRead(cookie, A.id, created.body.data.booking.appointmentId))
        .status,
    ).toBe(404);
  });

  it("an email opens its own appointment only: her other booking, never emailed, stays closed", async () => {
    const address = fresh("deux");
    const emailedId = await emailed(address, "10:00");
    // A second booking of hers whose confirmation has not gone out yet.
    const shown = await availability(A, serviceA, D4);
    const at = (shown.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === "16:00",
    )!;
    const other = await json(
      await book({ startsAt: at.startsAt, email: address }),
    );
    const otherId = other.body.data.booking.appointmentId as string;

    const cookie = await signIn(address);
    const slots = (id: string) =>
      getRescheduleSlots(
        request(
          "GET",
          `/api/client-hub/businesses/${A.id}/appointments/${id}/reschedule-slots?date=${D4}`,
          { cookie },
        ),
        params({ businessId: A.id, appointmentId: id }),
      );
    expect((await hubRead(cookie, A.id, emailedId)).status).toBe(200);
    expect((await slots(emailedId)).status).toBe(200);
    expect((await hubRead(cookie, A.id, otherId)).status).toBe(404);
    expect((await slots(otherId)).status).toBe(404);
    expect((await hubCancel(cookie, A.id, otherId, 1)).status).toBe(404);
  });

  it("the professional revoked the record's access: the email no longer opens it", async () => {
    const address = fresh("revoquee");
    const id = await emailed(address, "09:00");
    const cookie = await signIn(address);
    expect((await hubRead(cookie, A.id, id)).status).toBe(200);
    const { client_id } = await clientOf(id);
    for (const granted of [true, false]) {
      const answer = await ownerA.client.rpc(
        "client_hub_set_access" as never,
        {
          p_business_id: A.id,
          p_client_id: client_id,
          p_granted: granted,
          p_expected_email: address,
        } as never,
      );
      expect(answer.error).toBeNull();
    }
    expect((await hubRead(cookie, A.id, id)).status).toBe(404);
    const { version } = await clientOf(id);
    expect((await hubCancel(cookie, A.id, id, version)).status).toBe(404);
  });

  it("her address corrected by the professional, page already open: she can no longer cancel", async () => {
    const address = fresh("corrigee");
    const id = await emailed(address, "11:00");
    const cookie = await signIn(address);
    const opened = await hubRead(cookie, A.id, id);
    expect(opened.body.data.actions.cancel.allowed).toBe(true);
    const { client_id } = await clientOf(id);
    await db.query("update public.clients set email = $2 where id = $1", [
      client_id,
      fresh("bonne"),
    ]);
    const refused = await hubCancel(
      cookie,
      A.id,
      id,
      opened.body.data.actions.version,
    );
    expect(refused.status).toBe(404);
    expect((await hubRead(cookie, A.id, id)).status).toBe(404);
    const { rows } = await db.query(
      "select status from public.appointments where id = $1",
      [id],
    );
    expect(rows[0].status).toBe("confirmed");
  });

  it("given to another customer, page already open: the former recipient can no longer cancel", async () => {
    const first = fresh("avant");
    const id = await emailed(first, "13:00");
    const cookie = await signIn(first);
    const opened = await hubRead(cookie, A.id, id);
    expect(opened.status).toBe(200);

    const second = fresh("apres");
    const otherClient = await createClientRecord(A.id, second, "Zoé");
    const { rows } = await db.query(
      "select version, service_id, starts_at from public.appointments where id = $1",
      [id],
    );
    const moved = await ownerA.client.rpc(
      "agenda_update_appointment" as never,
      {
        p_business_id: A.id,
        p_appointment_id: id,
        p_expected_version: rows[0].version,
        p_service_id: rows[0].service_id,
        p_client_id: otherClient,
        p_starts_at: new Date(rows[0].starts_at).toISOString(),
      } as never,
    );
    expect(moved.error).toBeNull();
    const refused = await hubCancel(
      cookie,
      A.id,
      id,
      opened.body.data.actions.version,
    );
    expect(refused.status).toBe(404);
    expect((await hubRead(cookie, A.id, id)).status).toBe(404);
    // Nothing was ever sent to the new customer: nothing. After a
    // reassignment she gets a reminder, no confirmation
    // (NOTIFICATIONS_CONTRACT.md): a reminder alone opens nothing either.
    const newcomer = await signIn(second);
    expect((await hubRead(newcomer, A.id, id)).status).toBe(404);
    await db.query(
      `update public.email_events set scheduled_for = now() - interval '1 second'
       where appointment_id = $1 and type = 'appointment_reminder' and status = 'pending'`,
      [id],
    );
    await deliver(A.id);
    // Her sign-in code aside, one email: the reminder.
    expect(
      mailTo(second).filter((m) => !/^\d{8}/.test(m.subject)),
    ).toHaveLength(1);
    expect((await hubRead(newcomer, A.id, id)).status).toBe(404);
  });

  it("a failed send, or an attempt whose answer was lost, opens nothing", async () => {
    const failed = fresh("echec");
    const failedId = await booked(failed, "09:00", D5);
    transport.failNext("provider_rejected_422", "permanent");
    await deliver(A.id);
    const attempted = fresh("tentative");
    const attemptedId = await booked(attempted, "11:00", D5);
    transport.acceptThenFailNext();
    await deliver(A.id);

    expect(await sentOf(failedId)).toContainEqual({
      type: "booking_confirmation",
      status: "failed",
      submitted: true,
    });
    expect(
      (await sentOf(attemptedId)).find(
        (e) => e.type === "booking_confirmation",
      ),
    ).toMatchObject({ submitted: true });
    expect(
      (await sentOf(attemptedId)).find((e) => e.type === "booking_confirmation")
        ?.status,
    ).not.toBe("sent");
    expect((await hubRead(await signIn(failed), A.id, failedId)).status).toBe(
      404,
    );
    expect(
      (await hubRead(await signIn(attempted), A.id, attemptedId)).status,
    ).toBe(404);
  });

  it("a reminder alone, or a change email alone, opens nothing", async () => {
    const address = fresh("rappel");
    const id = await booked(address, "13:00", D5);
    transport.failNext("provider_rejected_422", "permanent");
    await deliver(A.id);
    const cookie = await signIn(address);

    // Her reminder goes out: still nothing.
    await db.query(
      `update public.email_events set scheduled_for = now() - interval '1 second'
       where appointment_id = $1 and type = 'appointment_reminder' and status = 'pending'`,
      [id],
    );
    await deliver(A.id);
    expect(await sentOf(id)).toContainEqual({
      type: "appointment_reminder",
      status: "sent",
      submitted: true,
    });
    expect((await hubRead(cookie, A.id, id)).status).toBe(404);

    // The professional moves it: the change email goes out, still nothing.
    const shown = await availability(A, serviceA, D5);
    const later = (shown.body.data.slots as Slot[]).find(
      (s) => s.localStartsAt.slice(11, 16) === "15:00",
    )!;
    const { rows } = await db.query(
      "select version, service_id, client_id from public.appointments where id = $1",
      [id],
    );
    const moved = await ownerA.client.rpc(
      "agenda_update_appointment" as never,
      {
        p_business_id: A.id,
        p_appointment_id: id,
        p_expected_version: rows[0].version,
        p_service_id: rows[0].service_id,
        p_client_id: rows[0].client_id,
        p_starts_at: later.startsAt,
      } as never,
    );
    expect(moved.error).toBeNull();
    await deliver(A.id);
    expect(await sentOf(id)).toContainEqual({
      type: "appointment_changed",
      status: "sent",
      submitted: true,
    });
    expect((await hubRead(cookie, A.id, id)).status).toBe(404);
  });

  it("« Retirer l'accès depuis les e-mails » on a record never opened, page already open: cut, nothing opened, for all her links", async () => {
    const address = fresh("retiree");
    const id = await emailed(address, "09:00", D6);
    const cookie = await signIn(address);
    const opened = await hubRead(cookie, A.id, id);
    expect(opened.body.data.actions.cancel.allowed).toBe(true);
    const { client_id } = await clientOf(id);

    const withdrawn = await ownerA.client.rpc(
      "client_hub_set_access" as never,
      {
        p_business_id: A.id,
        p_client_id: client_id,
        p_granted: false,
      } as never,
    );
    expect(withdrawn.error).toBeNull();
    const { rows } = await db.query(
      "select revoked_at is not null as revoked, revocation, granted_by from public.client_hub_access where client_id = $1",
      [client_id],
    );
    // Withdrawn without ever being granted: nothing was opened on the way.
    expect(rows).toEqual([
      { revoked: true, revocation: "withdrawn", granted_by: null },
    ]);
    const me = await json(
      await getHubMe(request("GET", "/api/client-hub/me", { cookie })),
    );
    expect(me.body.data.businesses).toEqual([]);

    // Her page was already open: cancelling is refused, reading too.
    const refused = await hubCancel(
      cookie,
      A.id,
      id,
      opened.body.data.actions.version,
    );
    expect(refused.status).toBe(404);
    expect((await hubRead(cookie, A.id, id)).status).toBe(404);

    // It covers the customer, not one address: her address corrected, a
    // new booking confirmed at the new one stays closed.
    const corrected = fresh("corrigee-retiree");
    await db.query("update public.clients set email = $2 where id = $1", [
      client_id,
      corrected,
    ]);
    const next = await emailed(corrected, "11:00", D6);
    expect((await clientOf(next)).client_id).toBe(client_id);
    expect((await hubRead(await signIn(corrected), A.id, next)).status).toBe(
      404,
    );
  });

  it("an address changed after a grant is no withdrawal: the new address manages its confirmed booking", async () => {
    const address = fresh("ouverte");
    const first = await emailed(address, "13:00", D6);
    const { client_id } = await clientOf(first);
    const granted = await ownerA.client.rpc(
      "client_hub_set_access" as never,
      {
        p_business_id: A.id,
        p_client_id: client_id,
        p_granted: true,
        p_expected_email: address,
      } as never,
    );
    expect(granted.error).toBeNull();
    const renamed = fresh("nouvelle-adresse");
    await db.query("update public.clients set email = $2 where id = $1", [
      client_id,
      renamed,
    ]);
    const next = await emailed(renamed, "15:00", D6);
    expect((await hubRead(await signIn(renamed), A.id, next)).status).toBe(200);
  });

  it("past the policy's limit, she is told, nothing changes", async () => {
    const address = fresh("tard");
    const id = await emailed(address, "15:00");
    // The appointment is now three hours away (moved by hand).
    await db.query(
      `update public.appointments
       set starts_at = now() + interval '3 hours', ends_at = now() + interval '4 hours'
       where id = $1`,
      [id],
    );
    const cookie = await signIn(address);
    const read = await hubRead(cookie, A.id, id);
    expect(read.status).toBe(200);
    expect(read.body.data.actions.cancel).toMatchObject({
      allowed: false,
      reason: "policy_cutoff_passed",
    });
    const refused = await hubCancel(
      cookie,
      A.id,
      id,
      read.body.data.actions.version,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("policy_cutoff_passed");
    const { rows } = await db.query(
      "select status from public.appointments where id = $1",
      [id],
    );
    expect(rows[0].status).toBe("confirmed");
  });
});

describe("point 152: her reminders are not marketing", () => {
  it("a withdrawn marketing consent never stops her appointment reminder", async () => {
    const address = `marketing-${randomUUID().slice(0, 6)}@client.test`;
    const shown = await availability(A, serviceA, D6);
    const at = (shown.body.data.slots as Slot[]).at(-1)!;
    const created = await json(
      await book({ startsAt: at.startsAt, email: address }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.booking.appointmentId as string;
    await deliver(A.id);
    const { rows } = await db.query<{ client_id: string }>(
      "select client_id from public.appointments where id = $1",
      [id],
    );

    // She says no to marketing (recorded by her professional).
    const withdrawn = await ownerA.client.rpc("marketing_set_consent", {
      p_business_id: A.id,
      p_client_id: rows[0]!.client_id,
      p_purpose: "marketing",
      p_channel: "email",
      p_action: "withdraw",
      p_proof_version: null,
      p_request_id: randomUUID(),
    } as never);
    expect(withdrawn.error).toBeNull();

    // Her reminder still goes out, and it is not a marketing message.
    await db.query(
      `update public.email_events set scheduled_for = now() - interval '1 second'
       where appointment_id = $1 and type = 'appointment_reminder' and status = 'pending'`,
      [id],
    );
    await deliver(A.id);
    const { rows: events } = await db.query<{ type: string; status: string }>(
      "select type, status from public.email_events where appointment_id = $1 order by created_at",
      [id],
    );
    expect(events).toEqual([
      { type: "booking_confirmation", status: "sent" },
      { type: "appointment_reminder", status: "sent" },
    ]);
    const reminder = mailTo(address).at(-1)!;
    expect(reminder.text).not.toMatch(/désinscri|unsubscribe/i);
  });
});

describe("point 204: each business sees its own", () => {
  it("B's owner sees nothing of A; the public page gives no customer data", async () => {
    const appointments = await ownerB.client
      .from("appointments")
      .select("id")
      .eq("business_id", A.id);
    expect(appointments.data).toEqual([]);
    const clients = await ownerB.client
      .from("clients")
      .select("id")
      .eq("business_id", A.id);
    expect(clients.data).toEqual([]);

    const page = await json(
      await getPublicBusiness(
        request("GET", `/api/public/businesses/${A.slug}`),
        params({ slug: A.slug }),
      ),
    );
    expect(page.status).toBe(200);
    const text = JSON.stringify(page.body);
    expect(text).not.toContain("@client.test");
    expect(text).not.toContain(ownerA.userId);
    expect(serviceB).toBeTruthy();
  });
});
