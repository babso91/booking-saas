import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { POST as postBooking } from "@/app/api/bookings/route";
import { GET as getTierProgress } from "@/app/api/client-hub/businesses/[businessId]/tier-progress/route";
import {
  GET as getReferral,
  POST as postReferral,
} from "@/app/api/client-hub/businesses/[businessId]/referral/route";
import { POST as postCode } from "@/app/api/client-hub/session/code/route";
import { POST as postVerify } from "@/app/api/client-hub/session/verify/route";
import { setClientHubAccessAction } from "@/features/client-hub/actions/access";
import type { ConfiguredTransport } from "@/features/notifications/transport";
import { MemoryTransport } from "@/features/notifications/transport/memory";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  bookingClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  env,
  everyDay,
  insertAppointment,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// VIP tiers and referral (docs/LOYALTY_TIERS_CONTRACT.md) against the real
// stack: the professional through PostgREST, the referrer through her
// Client Hub routes (a real code login), the referred customer through the
// public booking route, and the credits in the loyalty ledger.

let sessionClient: AppSupabaseClient;
let transport: MemoryTransport;
let configured: ConfiguredTransport | null;

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

const SECRET = "tiers-test-proxy-secret-0123456789abcdef";
const BASE = "http://localhost:3000";

beforeAll(() => {
  process.env.BOOKING_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
});

beforeEach(() => {
  transport = new MemoryTransport();
  configured = { transport, from: "Booking <noreply@test.local>" };
});

type Rpc = { data: unknown; error: { message: string } | null };
const call = (client: AppSupabaseClient, fn: string, args: object) =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

function request(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-booking-proxy-secret": SECRET,
    "x-booking-client-ip": randomIp(),
  });
  if (cookie) headers.set("cookie", `client_hub_session=${cookie}`);
  return new NextRequest(new URL(path, BASE), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = <T extends object>(value: T) => ({
  params: Promise.resolve(value),
});
async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

/** A real Client Hub login; the session token. */
async function login(email: string) {
  const asked = await json(
    await postCode(request("POST", "/api/client-hub/session/code", { email })),
  );
  const code = transport.sent[transport.sent.length - 1]!.subject.slice(0, 8);
  const verified = await postVerify(
    request("POST", "/api/client-hub/session/verify", {
      challengeId: asked.body.data.challengeId,
      email,
      code,
    }),
  );
  return verified.headers
    .get("set-cookie")!
    .match(/client_hub_session=([0-9a-f]{64})/)![1]!;
}

let owner: Professional;
let stranger: Professional;
let business: TestBusiness;
let serviceId: string;
let slot = 0;

const email = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}@client.test`;

function at(days: number) {
  slot += 1;
  const start = new Date(Date.now() + days * 86_400_000 + slot * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}

const setRules = (
  referralPoints: number | null,
  expectedVersion: number,
  tiers = [
    { name: "Argent", threshold: 2, perk: "-10 % sur les soins" },
    { name: "Or", threshold: 5, perk: null },
  ],
  who = owner,
) =>
  call(who.client, "loyalty_set_growth_rules", {
    p_business_id: business.id,
    p_tiers: tiers,
    p_window_days: 365,
    p_referral_points: referralPoints,
    p_expected_version: expectedVersion,
  });

/** A customer with Hub access, logged in: her id, email and session. */
async function hubCustomer(label: string) {
  const address = email(label);
  const clientId = await createClientRecord(business.id, address, "Léa");
  sessionClient = owner.client;
  const granted = await setClientHubAccessAction({ clientId, granted: true });
  expect(granted.ok).toBe(true);
  return { clientId, address, token: await login(address) };
}

/** A distinct free slot for a public booking. */
function nextSlot() {
  slot += 1;
  return `${dateInDays(3 + (slot % 20))}T${String(8 + (slot % 10)).padStart(2, "0")}:00:00.000Z`;
}

async function book(
  code: string | undefined,
  address: string,
  requestId = randomUUID(),
  startsAt = nextSlot(),
) {
  const response = await postBooking(
    request("POST", "/api/bookings", {
      slug: business.slug,
      serviceId,
      startsAt,
      firstName: "Nina",
      email: address,
      requestId,
      ...(code ? { referralCode: code } : {}),
    }),
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBeLessThan(300);
  return body.data.booking.appointmentId as string;
}

const referralOf = async (appointmentId: string) =>
  (
    await db.query(
      "select state, generation, reward_points from private.referrals where source_appointment_id = $1",
      [appointmentId],
    )
  ).rows[0] ?? null;

const rewards = async (clientId: string) =>
  (
    await db.query(
      `select type, points_delta from public.loyalty_events
       where client_id = $1 order by ledger_seq`,
      [clientId],
    )
  ).rows;

beforeAll(async () => {
  owner = await createProfessional("tiers-owner");
  stranger = await createProfessional("tiers-stranger");
  business = await createBusiness(owner.userId);
  await createBusiness(stranger.userId);
  serviceId = await createService(business.id, { name: "Pose" });
  await setWeeklyHours(business.id, everyDay(["06:00", "22:00"]));
  await db.query(
    `insert into public.loyalty_programs (business_id, active) values ($1, true)
     on conflict (business_id) do update set active = true`,
    [business.id],
  );
});

describe("rules", () => {
  it("are set by the owner on a version, with increasing thresholds", async () => {
    expect((await setRules(50, 0, undefined, stranger)).error?.message).toBe(
      "forbidden",
    );
    expect(
      (
        await setRules(50, 0, [
          { name: "A", threshold: 3, perk: null },
          { name: "B", threshold: 3, perk: null },
        ])
      ).error?.message,
    ).toBe("invalid_input");
    const saved = await ok<{ version: number; tiers: { id: string }[] }>(
      setRules(50, 0),
    );
    expect(saved.version).toBe(1);
    expect(saved.tiers.map((t) => t.id)).toEqual(["t2", "t5"]);
    expect((await setRules(50, 0)).error?.message).toBe("version_conflict");
  });
});

describe("tiers", () => {
  it("counts completed visits in the window, never cancelled ones nor older ones", async () => {
    const lea = await hubCustomer("tier");
    for (const days of [-30, -60, -90]) {
      await insertAppointment({
        businessId: business.id,
        clientId: lea.clientId,
        serviceId,
        status: "completed",
        ...at(days),
      });
    }
    await insertAppointment({
      businessId: business.id,
      clientId: lea.clientId,
      serviceId,
      status: "completed",
      ...at(-400),
    });
    await insertAppointment({
      businessId: business.id,
      clientId: lea.clientId,
      serviceId,
      status: "cancelled",
      ...at(-10),
    });

    const pro = await ok<Record<string, unknown>>(
      call(owner.client, "loyalty_client_tier_progress", {
        p_business_id: business.id,
        p_client_id: lea.clientId,
      }),
    );
    expect(pro).toMatchObject({
      tierId: "t2",
      currentValue: 3,
      nextThreshold: 5,
      windowDays: 365,
    });
    // The oldest counted visit (90 days ago) leaves the window in 275 days.
    const leaves = new Date(pro.windowEnd as string).getTime();
    expect(Math.round((leaves - Date.now()) / 86_400_000)).toBe(275);

    const hub = await json(
      await getTierProgress(
        request(
          "GET",
          `/api/client-hub/businesses/${business.id}/tier-progress`,
          undefined,
          lea.token,
        ),
        params({ businessId: business.id }),
      ),
    );
    expect(hub.body.data).toEqual(pro);
  });
});

describe("referral", () => {
  it("credits the referrer once per completion, reverses on reopening, credits a new generation", async () => {
    const lea = await hubCustomer("parrain");
    const path = `/api/client-hub/businesses/${business.id}/referral`;
    const requestId = randomUUID();
    const created = await json(
      await postReferral(
        request("POST", path, { requestId }, lea.token),
        params({ businessId: business.id }),
      ),
    );
    expect(created.status).toBe(200);
    const url = new URL(created.body.data.url);
    expect(url.pathname).toBe(`/b/${business.slug}`);
    const code = url.searchParams.get("parrainage")!;
    // A retry answers the same link; reading shows it.
    const again = await json(
      await postReferral(
        request("POST", path, { requestId }, lea.token),
        params({ businessId: business.id }),
      ),
    );
    expect(again.body.data.url).toBe(created.body.data.url);
    const read = await json(
      await getReferral(
        request("GET", path, undefined, lea.token),
        params({ businessId: business.id }),
      ),
    );
    expect(read.body.data).toMatchObject({ state: "active" });

    const nina = email("filleule");
    const bookingRequestId = randomUUID();
    const startsAt = nextSlot();
    const appointmentId = await book(code, nina, bookingRequestId, startsAt);
    expect(await referralOf(appointmentId)).toMatchObject({ state: "claimed" });
    // The same booking retried claims nothing more.
    await book(code, nina, bookingRequestId, startsAt);
    const { rows } = await db.query(
      "select count(*)::int as n from private.referrals where referrer_client_id = $1",
      [lea.clientId],
    );
    expect(rows[0].n).toBe(1);

    const setStatus = (status: string) =>
      db.query("update public.appointments set status = $2 where id = $1", [
        appointmentId,
        status,
      ]);
    await setStatus("completed");
    await setStatus("completed"); // a second callback: no second credit
    expect(await rewards(lea.clientId)).toEqual([
      { type: "referral_reward", points_delta: 50 },
    ]);

    await setStatus("confirmed");
    await setStatus("completed");
    expect(await rewards(lea.clientId)).toEqual([
      { type: "referral_reward", points_delta: 50 },
      { type: "correction", points_delta: -50 },
      { type: "referral_reward", points_delta: 50 },
    ]);
    expect(await referralOf(appointmentId)).toMatchObject({
      state: "rewarded",
      generation: 2,
    });

    // A new program value never changes what this first visit pays.
    await setRules(80, 1);
    await setStatus("confirmed");
    await setStatus("completed");
    expect((await rewards(lea.clientId)).at(-1)).toEqual({
      type: "referral_reward",
      points_delta: 50,
    });
  });

  it("never pays a self-referral, an existing customer, or a second attribution", async () => {
    const lea = await hubCustomer("parraine2");
    const created = await json(
      await postReferral(
        request(
          "POST",
          `/api/client-hub/businesses/${business.id}/referral`,
          { requestId: randomUUID() },
          lea.token,
        ),
        params({ businessId: business.id }),
      ),
    );
    const code = new URL(created.body.data.url).searchParams.get("parrainage")!;

    // Herself, through her own link.
    const own = await book(code, lea.address);
    expect(await referralOf(own)).toBeNull();

    // Someone who was already a customer.
    const known = email("ancienne");
    const knownId = await createClientRecord(business.id, known, "Ana");
    await insertAppointment({
      businessId: business.id,
      clientId: knownId,
      serviceId,
      status: "completed",
      ...at(-20),
    });
    expect(await referralOf(await book(code, known))).toBeNull();

    // Two first bookings of a new customer at once: one attribution.
    const twice = email("double");
    const [first, second] = await Promise.all([
      book(code, twice),
      book(code, twice),
    ]);
    const claims = [await referralOf(first), await referralOf(second)].filter(
      Boolean,
    );
    expect(claims).toHaveLength(1);

    // A code is good for its own business only.
    const otherOwner = await createProfessional("tiers-other");
    const other = await createBusiness(otherOwner.userId);
    const otherService = await createService(other.id, { name: "Coupe" });
    const elsewhere = await insertAppointment({
      businessId: other.id,
      clientId: await createClientRecord(other.id, email("ailleurs"), "Zoé"),
      serviceId: otherService,
      ...at(4),
    });
    expect(
      await ok(
        call(bookingClient(), "referral_claim", {
          p_code: code,
          p_appointment_id: elsewhere,
        }),
      ),
    ).toBe("unavailable");
  });

  it("a booking given to another customer before completion pays nothing", async () => {
    const lea = await hubCustomer("parraine4");
    const created = await json(
      await postReferral(
        request(
          "POST",
          `/api/client-hub/businesses/${business.id}/referral`,
          { requestId: randomUUID() },
          lea.token,
        ),
        params({ businessId: business.id }),
      ),
    );
    const code = new URL(created.body.data.url).searchParams.get("parrainage")!;
    const appointmentId = await book(code, email("filleule4"));
    expect(await referralOf(appointmentId)).toMatchObject({ state: "claimed" });

    // The professional gives the visit to the referrer herself, then completes it.
    await db.query(
      "update public.appointments set client_id = $2 where id = $1",
      [appointmentId, lea.clientId],
    );
    await db.query(
      "update public.appointments set status = 'completed' where id = $1",
      [appointmentId],
    );
    expect(await referralOf(appointmentId)).toMatchObject({
      state: "rejected",
    });
    expect(
      (await rewards(lea.clientId)).filter((r) => r.type === "referral_reward"),
    ).toEqual([]);
  });

  it("is refused without a referral offer, and to a customer whose Hub access was withdrawn", async () => {
    const lea = await hubCustomer("parraine3");
    const path = `/api/client-hub/businesses/${business.id}/referral`;
    const rules = await ok<{ version: number }>(
      call(owner.client, "loyalty_get_growth_rules", {
        p_business_id: business.id,
      }),
    );
    await setRules(null, rules.version);
    const refused = await json(
      await postReferral(
        request("POST", path, { requestId: randomUUID() }, lea.token),
        params({ businessId: business.id }),
      ),
    );
    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: "referral_unavailable" } },
    });
    await setRules(50, rules.version + 1);

    sessionClient = owner.client;
    await setClientHubAccessAction({ clientId: lea.clientId, granted: false });
    const gone = await json(
      await getReferral(
        request("GET", path, undefined, lea.token),
        params({ businessId: business.id }),
      ),
    );
    expect(gone.status).toBe(404);
  });
});
