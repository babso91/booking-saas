import { createHash, randomBytes, randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as postCancel } from "@/app/api/client-hub/businesses/[businessId]/appointments/[appointmentId]/cancel/route";
import { sessionCookieName } from "@/features/client-hub/data/session";
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
  setWeeklyHours,
  updateSettings,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// « Annuler ou déplacer » from her Hub (docs/CLIENT_HUB_CONTRACT.md) through
// PostgREST: the client with her Hub session token (service role, as the
// routes call it), the owner with her real session.

type Rpc = { data: unknown; error: { message: string } | null };
type Detail = {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  actions: {
    version: number;
    cancel: {
      allowed: boolean;
      deadlineAt: string | null;
      reason: string | null;
    };
    reschedule: {
      allowed: boolean;
      deadlineAt: string | null;
      reason: string | null;
    };
  } | null;
};

async function call(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> {
  const { data, error } = await (
    client.rpc as unknown as (f: string, a: object) => Promise<Rpc>
  )(fn, args);
  return { data, error };
}
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}
const refusal = async (promise: Promise<Rpc>) => (await promise).error?.message;

type Shop = { owner: Professional; business: TestBusiness; service: string };

async function newShop(label: string): Promise<Shop> {
  const owner = await createProfessional(label);
  const business = await createBusiness(owner.userId, { timezone: "UTC" });
  await updateSettings(business.id, {
    slot_interval_minutes: 30,
    buffer_minutes: 0,
    minimum_booking_notice_minutes: 0,
    maximum_booking_advance_days: 60,
  } as never);
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
  const service = await createService(business.id, {
    name: "Pose",
    durationMinutes: 60,
  });
  return { owner, business, service };
}

const setPolicy = (
  shop: Shop,
  cancel: number | null,
  reschedule: number | null,
) =>
  ok(
    call(shop.owner.client, "set_booking_policy", {
      p_business_id: shop.business.id,
      p_cancellation_lead_minutes: cancel,
      p_reschedule_lead_minutes: reschedule,
    }),
  );

async function hubSession(email: string) {
  const token = randomBytes(32).toString("hex");
  const { rows } = await db.query<{ id: string }>(
    `insert into private.client_hub_accounts (email) values ($1)
     on conflict (email) do update set last_login_at = now() returning id`,
    [email],
  );
  const session = await db.query<{ id: string }>(
    `insert into private.client_hub_sessions (account_id, token_hash, created_at, expires_at, last_seen_at)
     values ($1, $2, now(), now() + interval '1 day', now()) returning id`,
    [rows[0]!.id, createHash("sha256").update(token).digest("hex")],
  );
  return { token, sessionId: session.rows[0]!.id };
}

/** A client of `shop` with Hub access and a session. */
async function client(shop: Shop) {
  const email = `cliente-${randomUUID().slice(0, 8)}@client.test`;
  const clientId = await createClientRecord(shop.business.id, email, "Léa");
  await db.query(
    `insert into public.client_hub_access (business_id, client_id, email, granted_by) values ($1, $2, $3, $4)`,
    [shop.business.id, clientId, email, shop.owner.userId],
  );
  return { email, clientId, ...(await hubSession(email)) };
}

const at = (days: number, time: string) =>
  `${dateInDays(days)}T${time}:00.000Z`;

function book(shop: Shop, clientId: string, startsAt: string, minutes = 60) {
  return insertAppointment({
    businessId: shop.business.id,
    clientId,
    serviceId: shop.service,
    startsAt,
    endsAt: new Date(
      new Date(startsAt).getTime() + minutes * 60_000,
    ).toISOString(),
  });
}

const detail = (token: string, shop: Shop, appointmentId: string) =>
  ok<Detail>(
    call(bookingClient(), "client_hub_appointment", {
      p_session_token: token,
      p_business_id: shop.business.id,
      p_appointment_id: appointmentId,
    }),
  );

const cancel = (
  token: string,
  shop: Shop,
  appointmentId: string,
  version: number,
  requestId = randomUUID(),
) =>
  call(bookingClient(), "client_hub_cancel_appointment", {
    p_session_token: token,
    p_business_id: shop.business.id,
    p_appointment_id: appointmentId,
    p_expected_version: version,
    p_request_id: requestId,
  });

const move = (
  token: string,
  shop: Shop,
  appointmentId: string,
  version: number,
  startsAt: string,
  requestId = randomUUID(),
) =>
  call(bookingClient(), "client_hub_reschedule_appointment", {
    p_session_token: token,
    p_business_id: shop.business.id,
    p_appointment_id: appointmentId,
    p_expected_version: version,
    p_request_id: requestId,
    p_starts_at: startsAt,
  });

async function releases(appointmentId: string) {
  const { rows } = await db.query<{ reason: string; occupied_from: Date }>(
    "select reason, occupied_from from private.capacity_releases where appointment_id = $1 order by occurred_at",
    [appointmentId],
  );
  return rows;
}

let shop: Shop;

beforeAll(async () => {
  shop = await newShop("hub-actions");
});

describe("the policy, frozen with each appointment", () => {
  it("lets nothing be changed from the Hub without a policy, and keeps an appointment's own policy", async () => {
    const lea = await client(shop);
    const before = await book(shop, lea.clientId, at(5, "09:00"));
    expect((await detail(lea.token, shop, before)).actions).toMatchObject({
      cancel: { allowed: false, reason: "policy_unavailable" },
      reschedule: { allowed: false, reason: "policy_unavailable" },
    });

    await setPolicy(shop, 1440, 120);
    const after = await book(shop, lea.clientId, at(5, "11:00"));
    const actions = (await detail(lea.token, shop, after)).actions!;
    expect(actions.cancel).toEqual({
      allowed: true,
      deadlineAt: new Date(new Date(at(5, "11:00")).getTime() - 1440 * 60_000)
        .toISOString()
        .replace(".000Z", "+00:00"),
      reason: null,
    });
    expect(actions.reschedule.allowed).toBe(true);
    // The appointment made before the policy keeps having none.
    expect((await detail(lea.token, shop, before)).actions?.cancel.reason).toBe(
      "policy_unavailable",
    );
    expect(await refusal(cancel(lea.token, shop, before, 1))).toBe(
      "policy_unavailable",
    );
  });

  it("refuses after the deadline, and changes nothing", async () => {
    await setPolicy(shop, 1440, 1440);
    const lea = await client(shop);
    const soon = new Date(Date.now() + 2 * 3_600_000);
    soon.setUTCMinutes(soon.getUTCMinutes() < 30 ? 30 : 0, 0, 0);
    if (soon.getUTCMinutes() === 0) soon.setUTCHours(soon.getUTCHours() + 1);
    const appointmentId = await book(shop, lea.clientId, soon.toISOString());
    expect(await refusal(cancel(lea.token, shop, appointmentId, 1))).toBe(
      "policy_cutoff_passed",
    );
    expect((await detail(lea.token, shop, appointmentId)).status).toBe(
      "confirmed",
    );
    expect(await releases(appointmentId)).toHaveLength(0);
  });
});

describe("cancelling", () => {
  it("cancels once per requestId, refuses a stale version and another use of the key", async () => {
    await setPolicy(shop, 60, 60);
    const lea = await client(shop);
    const appointmentId = await book(shop, lea.clientId, at(6, "09:00"));
    expect(await refusal(cancel(lea.token, shop, appointmentId, 7))).toBe(
      "stale_appointment",
    );

    const requestId = randomUUID();
    const done = await ok<Detail>(
      cancel(lea.token, shop, appointmentId, 1, requestId),
    );
    expect(done).toMatchObject({ status: "cancelled", actions: null });
    expect(
      await ok<Detail>(cancel(lea.token, shop, appointmentId, 1, requestId)),
    ).toMatchObject({ status: "cancelled" });
    expect(
      await refusal(cancel(lea.token, shop, appointmentId, 2, requestId)),
    ).toBe("idempotency_conflict");
    expect((await releases(appointmentId)).map((r) => r.reason)).toEqual([
      "cancelled",
    ]);
    const { rows } = await db.query(
      "select count(*)::int as n from private.hub_appointment_changes where appointment_id = $1",
      [appointmentId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("answers as if nothing existed for another client, and after her access is revoked", async () => {
    await setPolicy(shop, 60, 60);
    const lea = await client(shop);
    const ines = await client(shop);
    const appointmentId = await book(shop, lea.clientId, at(6, "12:00"));
    expect(await refusal(cancel(ines.token, shop, appointmentId, 1))).toBe(
      "client_hub_not_found",
    );
    await db.query(
      "update public.client_hub_access set revoked_at = now() where client_id = $1",
      [lea.clientId],
    );
    expect(await refusal(cancel(lea.token, shop, appointmentId, 1))).toBe(
      "client_hub_not_found",
    );
    expect(await releases(appointmentId)).toHaveLength(0);
  });
});

describe("moving", () => {
  it("offers the day's times except its own, including one that overlaps only itself", async () => {
    await setPolicy(shop, 60, 60);
    const lea = await client(shop);
    const appointmentId = await book(shop, lea.clientId, at(8, "10:00"));
    const slots = await ok<{ timezone: string; slots: { startsAt: string }[] }>(
      call(bookingClient(), "client_hub_reschedule_slots", {
        p_session_token: lea.token,
        p_business_id: shop.business.id,
        p_appointment_id: appointmentId,
        p_date: dateInDays(8),
      }),
    );
    const starts = slots.slots.map((s) => new Date(s.startsAt).toISOString());
    expect(slots.timezone).toBe("UTC");
    expect(starts).not.toContain(at(8, "10:00"));
    expect(starts).toContain(at(8, "10:30"));
    expect(starts).toContain(at(8, "09:30"));

    const moved = await ok<Detail>(
      move(lea.token, shop, appointmentId, 1, at(8, "10:30")),
    );
    expect(new Date(moved.startsAt).toISOString()).toBe(at(8, "10:30"));
    expect(new Date(moved.endsAt).toISOString()).toBe(at(8, "11:30"));
    expect(moved.actions?.version).toBe(2);
    expect(await releases(appointmentId)).toEqual([
      expect.objectContaining({
        reason: "rescheduled",
        occupied_from: new Date(at(8, "10:00")),
      }),
    ]);
  });

  it("keeps the original when the new time is taken, and one of two clients wins a slot", async () => {
    await setPolicy(shop, 60, 60);
    const lea = await client(shop);
    const ines = await client(shop);
    const other = await client(shop);
    const leaAppt = await book(shop, lea.clientId, at(9, "09:00"));
    const inesAppt = await book(shop, ines.clientId, at(9, "13:00"));
    await book(shop, other.clientId, at(9, "16:00"));

    expect(
      await refusal(move(lea.token, shop, leaAppt, 1, at(9, "16:30"))),
    ).toBe("slot_unavailable");
    expect(
      await refusal(move(lea.token, shop, leaAppt, 1, at(9, "21:00"))),
    ).toBe("slot_unavailable");
    expect(
      new Date((await detail(lea.token, shop, leaAppt)).startsAt).toISOString(),
    ).toBe(at(9, "09:00"));

    const outcomes = await Promise.all([
      move(lea.token, shop, leaAppt, 1, at(9, "11:00")),
      move(ines.token, shop, inesAppt, 1, at(9, "11:00")),
    ]);
    const messages = outcomes.map((o) => o.error?.message ?? "ok").sort();
    expect(messages).toEqual(["ok", "slot_unavailable"]);
  });
});

describe("the cancel route", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  });

  it("refuses another origin, then cancels", async () => {
    await setPolicy(shop, 60, 60);
    const lea = await client(shop);
    const appointmentId = await book(shop, lea.clientId, at(10, "09:00"));
    const post = (headers: Record<string, string> = {}) =>
      postCancel(
        new NextRequest(
          new URL(
            `/api/client-hub/businesses/${shop.business.id}/appointments/${appointmentId}/cancel`,
            "http://localhost:3000",
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: `${sessionCookieName(lea.sessionId)}=${lea.token}`,
              ...headers,
            },
            body: JSON.stringify({
              requestId: randomUUID(),
              expectedVersion: 1,
            }),
          },
        ),
        {
          params: Promise.resolve({
            businessId: shop.business.id,
            appointmentId,
          }),
        },
      );
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    const done = await post();
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({
      data: { status: "cancelled", actions: null },
    });
  });
});
