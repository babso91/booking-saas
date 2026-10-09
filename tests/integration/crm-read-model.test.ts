import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  getClientProfileAction,
  listClientsAction,
  listClientTimelineAction,
} from "@/features/crm/actions/crm";
import type {
  ClientProfileDto,
  ClientSort,
  ClientTimelineEvent,
  ClientTimelinePageDto,
  DirectoryClientDto,
  DirectoryPageDto,
} from "@/features/crm/types";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import { closeTransaction, openTransaction } from "./support/transactions";

// CRM V1, relationship read model: directory, profile and timeline through
// the real Server Actions, the user's Supabase session, PostgreSQL row level
// security and public.business_time. Customers and their history are
// arranged directly in the database (as postgres), then only read.

let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));

function as(professional: Professional | null) {
  sessionClient = professional ? professional.client : anonClient();
}

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function failure<T>(result: ActionResult<T>, code: AppErrorCode) {
  expect(result).toMatchObject({ ok: false, error: { code } });
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** `days` from now (UTC), at `hour`:`minute` UTC. */
function at(days: number, hour = 9, minute = 0) {
  const date = new Date(Date.now() + days * DAY);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
}

const plus = (iso: string, minutes: number) =>
  new Date(new Date(iso).getTime() + minutes * MINUTE).toISOString();

async function appointment(
  business: string,
  client: string,
  service: string,
  startsAt: string,
  status?: "confirmed" | "completed" | "cancelled" | "no_show",
  minutes = 60,
) {
  return insertAppointment({
    businessId: business,
    clientId: client,
    serviceId: service,
    startsAt,
    endsAt: plus(startsAt, minutes),
    status,
  });
}

async function customer(
  business: string,
  fields: {
    firstName: string;
    lastName?: string;
    email?: string | null;
    phone?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.clients (business_id, first_name, last_name, email, phone)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      business,
      fields.firstName,
      fields.lastName ?? null,
      fields.email ?? null,
      fields.phone ?? null,
    ],
  );
  return rows[0]!.id;
}

async function email(
  business: string,
  client: string,
  fields: {
    createdAt: string;
    status?: "pending" | "processing" | "sent" | "failed" | "cancelled";
    sentAt?: string;
    appointment?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.email_events
       (business_id, client_id, appointment_id, type, recipient_email, payload, dedupe_key,
        status, scheduled_for, sent_at, provider_message_id, last_error, created_at, attempt_count)
     values ($1, $2, $3, 'booking_confirmation', 'lea@example.test',
             '{"secret":"SECRET-PAYLOAD"}', $4, $5, $6, $7, 'PROVIDER-ID-123', 'SMTP-ERROR-TEXT', $6, 1)
     returning id`,
    [
      business,
      client,
      fields.appointment ?? null,
      `crm-${randomUUID()}`,
      fields.status ?? "pending",
      fields.createdAt,
      fields.sentAt ?? null,
    ],
  );
  return rows[0]!.id;
}

async function loyalty(
  business: string,
  client: string,
  fields: {
    type: "appointment_completed" | "manual_adjustment" | "reward_redeemed";
    points: number;
    createdAt: string;
    appointment?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.loyalty_events
       (business_id, client_id, appointment_id, type, points_delta, reason, idempotency_key, created_at)
     values ($1, $2, $3, $4, $5, 'Motif', $6, $7) returning id`,
    [
      business,
      client,
      fields.appointment ?? null,
      fields.type,
      fields.points,
      `crm-${randomUUID()}`,
      fields.createdAt,
    ],
  );
  return rows[0]!.id;
}

/** Every page of the directory, `limit` at a time. */
async function allPages(
  input: { sort?: ClientSort; filter?: string; query?: string },
  limit: number,
) {
  const pages: DirectoryPageDto[] = [];
  let cursor: string | null = null;
  do {
    const page: DirectoryPageDto = ok(
      await listClientsAction({ ...input, limit, cursor }),
    );
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

async function timeline(clientId: string, limit: number) {
  const events: ClientTimelineEvent[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: ClientTimelinePageDto = ok(
      await listClientTimelineAction({ clientId, limit, cursor }),
    );
    events.push(...page.events);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  return { events, pages };
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const sortedIds = (...values: string[]) => [...values].sort();

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

let ownerA: Professional;
let ownerB: Professional;
let A: TestBusiness;
let B: TestBusiness;
let coupe: string;
let couleur: string;
const c: Record<string, string> = {};
const appt: Record<string, string> = {};
const ev: Record<string, string> = {};

beforeAll(async () => {
  ownerA = await createProfessional("crm-a");
  ownerB = await createProfessional("crm-b");
  A = await createBusiness(ownerA.userId, { timezone: "Europe/Paris" });
  B = await createBusiness(ownerB.userId, { timezone: "Europe/Paris" });
  coupe = await createService(A.id, { name: "Coupe", priceCents: 4000 });
  couleur = await createService(A.id, { name: "Couleur", priceCents: 6000 });
  const coupeB = await createService(B.id, { name: "Coupe", priceCents: 9900 });

  // Business A, created in this order (newest last).
  c.lea = await customer(A.id, {
    firstName: "Léa",
    lastName: "Martin",
    email: "lea@example.test",
    phone: "06 12 34 56 78",
  });
  c.emma = await createClientRecord(A.id, "emma@example.com", "Emma");
  c.zoe = await customer(A.id, { firstName: "Zoé", lastName: "Sans" });
  c.ines = await customer(A.id, {
    firstName: "Inès",
    lastName: "Durand",
    email: "ines@example.test",
  });
  // Business B: a customer with the same email as A's Emma.
  c.emmaB = await createClientRecord(B.id, "emma@example.com", "Emma");

  // Léa: the metrics matrix.
  appt.leaCoupe1 = await appointment(A.id, c.lea, coupe, at(-30), "completed");
  appt.leaCoupe2 = await appointment(A.id, c.lea, coupe, at(-20), "completed");
  // Same start as a completed one: cancelled rows do not occupy the slot.
  appt.leaCancelledSame = await appointment(
    A.id,
    c.lea,
    coupe,
    at(-20),
    "cancelled",
  );
  appt.leaCouleur1 = await appointment(
    A.id,
    c.lea,
    couleur,
    at(-10),
    "completed",
  );
  appt.leaNoShow = await appointment(A.id, c.lea, coupe, at(-8), "no_show");
  appt.leaCouleur2 = await appointment(
    A.id,
    c.lea,
    couleur,
    at(-5),
    "completed",
  );
  // Past and still confirmed: no outcome recorded, never a visit.
  appt.leaPastConfirmed = await appointment(
    A.id,
    c.lea,
    coupe,
    at(-3),
    "confirmed",
  );
  appt.leaNext = await appointment(A.id, c.lea, coupe, at(2), "confirmed");
  appt.leaCancelledFuture = await appointment(
    A.id,
    c.lea,
    couleur,
    at(5),
    "cancelled",
  );
  appt.leaLater = await appointment(A.id, c.lea, couleur, at(7), "confirmed");
  // The price of a service changes after the fact: recorded prices stay.
  await db.query(
    "update public.services set price_cents = 99999 where id = any($1)",
    [[coupe, couleur]],
  );
  // Marked completed later than the visit itself.
  await db.query(
    "update public.appointments set completed_at = $2 where id = $1",
    [appt.leaCouleur2, plus(at(-5), 180)],
  );

  // Léa's other history: loyalty ledger (with one reward redemption) and
  // emails of every status; one email at the very instant of a visit.
  ev.loyaltyEarned = await loyalty(A.id, c.lea, {
    type: "appointment_completed",
    points: 1,
    createdAt: plus(at(-30), 120),
    appointment: appt.leaCoupe1,
  });
  ev.loyaltyGift = await loyalty(A.id, c.lea, {
    type: "manual_adjustment",
    points: 5,
    createdAt: at(-25, 12),
  });
  ev.loyaltyRedeemed = await loyalty(A.id, c.lea, {
    type: "reward_redeemed",
    points: -4,
    createdAt: at(-9, 12),
  });
  const { rows: reward } = await db.query<{ id: string }>(
    `insert into public.rewards (business_id, name, points_required, reward_type)
     values ($1, 'Soin offert', 4, 'free_service') returning id`,
    [A.id],
  );
  await db.query(
    `insert into public.reward_redemptions
       (business_id, reward_id, client_id, loyalty_event_id, points_spent, redeemed_at)
     values ($1, $2, $3, $4, 4, $5)`,
    [A.id, reward[0]!.id, c.lea, ev.loyaltyRedeemed, at(-9, 12)],
  );
  ev.emailPending = await email(A.id, c.lea, {
    createdAt: at(-1, 10),
    appointment: appt.leaNext,
  });
  ev.emailSent = await email(A.id, c.lea, {
    createdAt: at(-29, 10),
    status: "sent",
    sentAt: at(-29, 11),
  });
  ev.emailFailed = await email(A.id, c.lea, {
    createdAt: at(-15, 10),
    status: "failed",
  });
  ev.emailSameInstant = await email(A.id, c.lea, {
    createdAt: at(-10),
    status: "sent",
    sentAt: at(-10),
  });

  // Emma (A): one visit. Inès: only a future booking. Zoé: nothing.
  appt.emmaVisit = await appointment(
    A.id,
    c.emma,
    coupe,
    at(-3, 14),
    "completed",
  );
  appt.inesNext = await appointment(A.id, c.ines, couleur, at(10), "confirmed");

  // Emma (B): a richer history, never visible from A.
  for (let day = 1; day <= 4; day += 1) {
    await appointment(B.id, c.emmaB, coupeB, at(-day, 10), "completed");
  }
  await appointment(B.id, c.emmaB, coupeB, at(3, 10), "confirmed");
  await loyalty(B.id, c.emmaB, {
    type: "manual_adjustment",
    points: 7,
    createdAt: at(-2, 12),
  });
  await email(B.id, c.emmaB, {
    createdAt: at(-2, 13),
    status: "sent",
    sentAt: at(-2, 13),
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("security: professionals of the business only", () => {
  it("a member reads her own directory, profiles and timelines", async () => {
    as(ownerA);
    const page = ok(await listClientsAction({ limit: 100 }));
    expect(sortedIds(...ids(page.clients))).toEqual(
      sortedIds(c.lea!, c.emma!, c.zoe!, c.ines!),
    );
    expect(page.totalCount).toBe(4);
    expect(
      ok(await getClientProfileAction({ clientId: c.lea })).client.id,
    ).toBe(c.lea);
    expect(
      ok(await listClientTimelineAction({ clientId: c.lea })).events.length,
    ).toBeGreaterThan(0);
  });

  it("the same email in two businesses: each sees only her own customer, counts included", async () => {
    as(ownerA);
    const mine = ok(await listClientsAction({ query: "emma@example.com" }));
    expect(ids(mine.clients)).toEqual([c.emma]);
    expect(mine.totalCount).toBe(1);
    expect(mine.clients[0]).toMatchObject({
      completedCount: 1,
      upcomingCount: 0,
    });

    as(ownerB);
    const theirs = ok(await listClientsAction({ query: "emma@example.com" }));
    expect(ids(theirs.clients)).toEqual([c.emmaB]);
    expect(theirs.totalCount).toBe(1);
    expect(theirs.clients[0]).toMatchObject({
      completedCount: 4,
      upcomingCount: 1,
    });
    const profile = ok(await getClientProfileAction({ clientId: c.emmaB }));
    expect(profile.overview).toMatchObject({
      completedCount: 4,
      upcomingCount: 1,
    });
    const history = await timeline(c.emmaB!, 50);
    expect(history.events.map((event) => event.kind).sort()).toEqual([
      "appointment",
      "appointment",
      "appointment",
      "appointment",
      "email",
      "loyalty",
    ]);
  });

  it("another business's customer id is not found, by action and by direct call", async () => {
    as(ownerA);
    failure(
      await getClientProfileAction({ clientId: c.emmaB }),
      "client_not_found",
    );
    failure(
      await listClientTimelineAction({ clientId: c.emmaB }),
      "client_not_found",
    );
    failure(
      await getClientProfileAction({ clientId: randomUUID() }),
      "client_not_found",
    );

    const profile = await ownerA.client.rpc("crm_client_profile", {
      p_business_id: A.id,
      p_client_id: c.emmaB!,
    });
    expect(profile.error?.message).toBe("client_not_found");
    const history = await ownerA.client.rpc("crm_client_timeline", {
      p_business_id: A.id,
      p_client_id: c.emmaB!,
    });
    expect(history.error?.message).toBe("client_not_found");
  });

  it("another business id is forbidden for every read", async () => {
    const calls = [
      ownerA.client.rpc("crm_list_clients", { p_business_id: B.id }),
      ownerA.client.rpc("crm_client_profile", {
        p_business_id: B.id,
        p_client_id: c.emmaB!,
      }),
      ownerA.client.rpc("crm_client_timeline", {
        p_business_id: B.id,
        p_client_id: c.emmaB!,
      }),
      ownerA.client.rpc("crm_client_activity", {
        p_business_id: B.id,
        p_as_of: new Date().toISOString(),
      }),
    ];
    for (const { data, error } of await Promise.all(calls)) {
      expect(data).toBeNull();
      expect(error?.message).toBe("forbidden");
    }
  });

  it("anonymous callers (the public booking client) cannot call the CRM at all", async () => {
    const anon = anonClient();
    const calls = [
      anon.rpc("crm_list_clients", { p_business_id: A.id }),
      anon.rpc("crm_client_profile", {
        p_business_id: A.id,
        p_client_id: c.lea!,
      }),
      anon.rpc("crm_client_timeline", {
        p_business_id: A.id,
        p_client_id: c.lea!,
      }),
      anon.rpc("crm_client_activity", {
        p_business_id: A.id,
        p_as_of: new Date().toISOString(),
      }),
    ];
    for (const { data, error } of await Promise.all(calls)) {
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    }
    const { rows } = await db.query(
      `select r.rolname as role, bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) as execute
       from pg_proc p cross join pg_roles r
       where p.proname like 'crm\\_%' and p.pronamespace = 'public'::regnamespace
         and r.rolname in ('anon', 'authenticated')
       group by r.rolname order by r.rolname`,
    );
    expect(rows).toEqual([
      { role: "anon", execute: false },
      { role: "authenticated", execute: true },
    ]);

    as(null);
    failure(await listClientsAction({}), "unauthenticated");
    failure(
      await getClientProfileAction({ clientId: c.lea }),
      "unauthenticated",
    );
    failure(
      await listClientTimelineAction({ clientId: c.lea }),
      "unauthenticated",
    );
  });

  it("a signed-in professional without a business reads nothing", async () => {
    const stranger = await createProfessional("crm-stranger");
    as(stranger);
    failure(await listClientsAction({}), "no_business");
    const { data, error } = await stranger.client.rpc("crm_list_clients", {
      p_business_id: A.id,
    });
    expect(data).toBeNull();
    expect(error?.message).toBe("forbidden");
  });

  it("RLS stays authoritative under the functions: as a member of A, rows of B are invisible", async () => {
    const member = await openTransaction({
      role: "authenticated",
      userId: ownerA.userId,
    });
    try {
      // The membership check passes (A), yet a row of B could never be
      // read through these functions: RLS hides it from the caller.
      const { rows } = await member.connection.query(
        "select count(*)::int as n from public.appointments where business_id = $1",
        [B.id],
      );
      expect(rows[0]).toEqual({ n: 0 });
      const { rows: functions } = await member.connection.query(
        `select p.proname, p.prosecdef as definer
         from pg_proc p
         where p.proname like 'crm\\_%' and p.pronamespace = 'public'::regnamespace
         order by 1`,
      );
      expect(functions.every((row) => row.definer === false)).toBe(true);
    } finally {
      await closeTransaction(member, "rollback");
    }
  });

  it("a cursor is never authority: another customer's cursor is refused, another business's only positions", async () => {
    as(ownerB);
    const theirs = ok(
      await listClientTimelineAction({ clientId: c.emmaB, limit: 1 }),
    );
    expect(theirs.nextCursor).not.toBeNull();

    as(ownerA);
    // B's cursor on A's customer: refused (made for another customer).
    failure(
      await listClientTimelineAction({
        clientId: c.lea,
        cursor: theirs.nextCursor,
      }),
      "validation_error",
    );
    // B's cursor with B's customer, under A's session: still not found.
    failure(
      await listClientTimelineAction({
        clientId: c.emmaB,
        cursor: theirs.nextCursor,
      }),
      "client_not_found",
    );

    as(ownerB);
    const directory = ok(await listClientsAction({ limit: 1, sort: "newest" }));
    as(ownerA);
    // Positions within A's own customers only.
    const page = ok(
      await listClientsAction({
        limit: 100,
        sort: "newest",
        cursor: directory.nextCursor,
      }),
    );
    for (const row of page.clients) {
      expect([c.lea, c.emma, c.zoe, c.ines]).toContain(row.id);
    }
    expect(page.totalCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe("metrics: exact definitions", () => {
  let lea: ClientProfileDto;

  beforeAll(async () => {
    as(ownerA);
    lea = ok(await getClientProfileAction({ clientId: c.lea }));
  });

  it("completed, cancelled, no-show, past confirmed and upcoming are counted by persisted status only", () => {
    expect(lea.overview).toMatchObject({
      // Two Coupe, two Couleur.
      completedCount: 4,
      // One past (same start as a visit), one future.
      cancelledCount: 2,
      noShowCount: 1,
      // A past appointment never marked: not a visit.
      pastConfirmedCount: 1,
      upcomingCount: 2,
    });
  });

  it("first and last completed visit are the starts of the completed appointments", () => {
    expect(lea.overview.firstCompletedVisitAt?.at).toBe(at(-30));
    // The latest completed one, not the past confirmed one after it, and not
    // when it was marked completed.
    expect(lea.overview.lastCompletedVisitAt?.at).toBe(at(-5));
  });

  it("the next appointment is the earliest upcoming confirmed one; a cancelled future one is not", () => {
    expect(lea.nextAppointment).toMatchObject({
      id: appt.leaNext,
      status: "confirmed",
      startsAt: { at: at(2) },
      service: { id: coupe, name: "Coupe", durationMinutes: 60 },
      price: { amountCents: 4000, currency: "EUR" },
    });
    expect(ids(lea.upcoming)).toEqual([appt.leaNext, appt.leaLater]);
  });

  it("favourite service: most completed visits, ties to the most recent visit", () => {
    expect(lea.overview.favoriteService).toEqual({
      serviceId: couleur,
      currentName: "Couleur",
      active: true,
      completedCount: 2,
    });
  });

  it("completed service value: prices recorded on completed appointments only, current prices ignored", () => {
    // 2 × 4000 + 2 × 6000: not the 99999 the services cost today, nothing
    // from the cancelled, no-show or past confirmed appointments.
    expect(lea.overview.completedServiceValue).toEqual([
      { currency: "EUR", amountCents: 20000, appointmentCount: 4 },
    ]);
  });

  it("several currencies are never summed together", async () => {
    const client = await customer(A.id, { firstName: "Multi" });
    const eur = await appointment(
      A.id,
      client,
      coupe,
      at(-40, 15),
      "completed",
    );
    const chf = await appointment(
      A.id,
      client,
      coupe,
      at(-41, 15),
      "completed",
    );
    try {
      await db.query(
        `update public.appointments
         set currency = case when id = $2 then 'CHF' else 'EUR' end,
             price_cents_snapshot = case when id = $2 then 7000 else 4500 end
         where id = any($1)`,
        [[eur, chf], chf],
      );
      as(ownerA);
      const profile = ok(await getClientProfileAction({ clientId: client }));
      expect(profile.overview.completedServiceValue).toEqual([
        { currency: "CHF", amountCents: 7000, appointmentCount: 1 },
        { currency: "EUR", amountCents: 4500, appointmentCount: 1 },
      ]);
    } finally {
      await db.query("delete from public.appointments where id = any($1)", [
        [eur, chf],
      ]);
      await db.query("delete from public.clients where id = $1", [client]);
    }
  });

  it("empty and partial data: no fabricated values", async () => {
    as(ownerA);
    const zoe = ok(await getClientProfileAction({ clientId: c.zoe }));
    expect(zoe).toMatchObject({
      client: { firstName: "Zoé", lastName: "Sans", email: null, phone: null },
      overview: {
        completedCount: 0,
        cancelledCount: 0,
        noShowCount: 0,
        pastConfirmedCount: 0,
        upcomingCount: 0,
        firstCompletedVisitAt: null,
        lastCompletedVisitAt: null,
        favoriteService: null,
        completedServiceValue: [],
      },
      nextAppointment: null,
      upcoming: [],
    });
    const history = ok(await listClientTimelineAction({ clientId: c.zoe }));
    expect(history).toMatchObject({ events: [], nextCursor: null });

    // Only a future booking: upcoming, no history yet.
    const ines = ok(await getClientProfileAction({ clientId: c.ines }));
    expect(ines.overview).toMatchObject({
      completedCount: 0,
      upcomingCount: 1,
    });
    expect(ines.nextAppointment?.id).toBe(appt.inesNext);
    expect(
      ok(await listClientTimelineAction({ clientId: c.ines })).events,
    ).toEqual([]);
  });

  it("directory and profile agree for every customer (one definition)", async () => {
    as(ownerA);
    const page = ok(await listClientsAction({ limit: 100 }));
    for (const row of page.clients) {
      const profile = ok(await getClientProfileAction({ clientId: row.id }));
      expect({
        completedCount: row.completedCount,
        lastCompletedVisitAt: row.lastCompletedVisitAt,
        upcomingCount: row.upcomingCount,
        next: row.nextAppointment?.id ?? null,
        nextAt: row.nextAppointment?.startsAt ?? null,
      }).toEqual({
        completedCount: profile.overview.completedCount,
        lastCompletedVisitAt: profile.overview.lastCompletedVisitAt,
        upcomingCount: profile.overview.upcomingCount,
        next: profile.nextAppointment?.id ?? null,
        nextAt: profile.nextAppointment?.startsAt ?? null,
      });
    }
  });

  it("the upcoming boundary is the reference instant: started a minute ago is past confirmed, starting in minutes is upcoming", async () => {
    const client = await customer(A.id, { firstName: "Edge" });
    const now = Date.now();
    const started = await insertAppointment({
      businessId: A.id,
      clientId: client,
      serviceId: coupe,
      startsAt: new Date(now - 40 * MINUTE).toISOString(),
      endsAt: new Date(now + 1 * MINUTE).toISOString(),
    });
    const soon = await insertAppointment({
      businessId: A.id,
      clientId: client,
      serviceId: coupe,
      startsAt: new Date(now + 3 * MINUTE).toISOString(),
      endsAt: new Date(now + 33 * MINUTE).toISOString(),
    });
    as(ownerA);
    const profile = ok(await getClientProfileAction({ clientId: client }));
    expect(profile.overview).toMatchObject({
      completedCount: 0,
      pastConfirmedCount: 1,
      upcomingCount: 1,
    });
    expect(profile.nextAppointment?.id).toBe(soon);
    const history = ok(await listClientTimelineAction({ clientId: client }));
    expect(history.events.map((event) => event.id)).toEqual([
      `appointment:${started}`,
    ]);
    await db.query("delete from public.appointments where id = any($1)", [
      [started, soon],
    ]);
    await db.query("delete from public.clients where id = $1", [client]);
  });
});

// ---------------------------------------------------------------------------
// Directory: search, filters, orderings, pagination
// ---------------------------------------------------------------------------

describe("directory", () => {
  const search = async (query: string) => {
    as(ownerA);
    const page = ok(await listClientsAction({ query, limit: 100 }));
    return { ids: sortedIds(...ids(page.clients)), total: page.totalCount };
  };

  it("searches first name, last name, both orders, email and phone (digits too)", async () => {
    for (const query of [
      "léa",
      "LÉA",
      "martin",
      "Léa Martin",
      "martin léa",
      "lea@example",
      "06 12",
      "0612",
      "345678",
    ]) {
      expect(await search(query)).toEqual({ ids: [c.lea], total: 1 });
    }
    expect(await search("emma")).toEqual({ ids: [c.emma], total: 1 });
    expect(await search("  ")).toEqual({
      ids: sortedIds(c.lea!, c.emma!, c.zoe!, c.ines!),
      total: 4,
    });
  });

  it("is parameterized: wildcards are literal, SQL text is just text", async () => {
    expect(await search("%")).toEqual({ ids: [], total: 0 });
    expect(await search("_")).toEqual({ ids: [], total: 0 });
    expect(await search("'; delete from public.clients; --")).toEqual({
      ids: [],
      total: 0,
    });
    const { rows } = await db.query(
      "select count(*)::int as n from public.clients where business_id = $1",
      [A.id],
    );
    expect(rows[0]).toEqual({ n: 4 });
  });

  it("filters on upcoming appointments and completed visits", async () => {
    as(ownerA);
    const filtered = async (filter: string) =>
      sortedIds(
        ...ids(ok(await listClientsAction({ filter, limit: 100 })).clients),
      );
    expect(await filtered("upcoming")).toEqual(sortedIds(c.lea!, c.ines!));
    expect(await filtered("no_upcoming")).toEqual(sortedIds(c.emma!, c.zoe!));
    expect(await filtered("visited")).toEqual(sortedIds(c.lea!, c.emma!));
    expect(await filtered("never_visited")).toEqual(sortedIds(c.zoe!, c.ines!));
    failure(await listClientsAction({ filter: "vip" }), "validation_error");
  });

  it("orders deterministically, ties broken by id", async () => {
    as(ownerA);
    const order = async (sort: ClientSort) =>
      ids(ok(await listClientsAction({ sort, limit: 100 })).clients);
    const [none1, none2] = sortedIds(c.zoe!, c.ines!);
    expect(await order("name")).toEqual([c.emma, c.ines, c.lea, c.zoe]);
    expect(await order("newest")).toEqual([c.ines, c.zoe, c.emma, c.lea]);
    // Emma's visit (3 days ago) is more recent than Léa's (5 days ago).
    expect(await order("last_visit")).toEqual([c.emma, c.lea, none1, none2]);
    const [noNext1, noNext2] = sortedIds(c.emma!, c.zoe!);
    expect(await order("next_appointment")).toEqual([
      c.lea,
      c.ines,
      noNext1,
      noNext2,
    ]);
    expect(await order("most_visits")).toEqual([c.lea, c.emma, none1, none2]);
  });

  it("pages through every ordering and filter: same rows as one read, no duplicate, stable total", async () => {
    as(ownerA);
    for (const sort of [
      "name",
      "newest",
      "last_visit",
      "next_appointment",
      "most_visits",
    ] as const) {
      for (const filter of ["all", "no_upcoming"]) {
        const whole = ok(await listClientsAction({ sort, filter, limit: 100 }));
        for (const limit of [1, 2, 3]) {
          const pages = await allPages({ sort, filter }, limit);
          const rows: DirectoryClientDto[] = pages.flatMap(
            (page) => page.clients,
          );
          expect(ids(rows)).toEqual(ids(whole.clients));
          expect(new Set(ids(rows)).size).toBe(rows.length);
          expect(new Set(pages.map((page) => page.totalCount))).toEqual(
            new Set([whole.totalCount]),
          );
          // One reference instant for every page of one read.
          expect(new Set(pages.map((page) => page.asOf)).size).toBe(1);
        }
      }
    }
  });

  it("a cursor made for another ordering, filter or search is refused", async () => {
    as(ownerA);
    const page = ok(await listClientsAction({ sort: "name", limit: 1 }));
    failure(
      await listClientsAction({
        sort: "newest",
        limit: 1,
        cursor: page.nextCursor,
      }),
      "validation_error",
    );
    failure(
      await listClientsAction({
        sort: "name",
        filter: "visited",
        limit: 1,
        cursor: page.nextCursor,
      }),
      "validation_error",
    );
    failure(
      await listClientsAction({ sort: "name", limit: 1, cursor: "garbage" }),
      "validation_error",
    );
    failure(await listClientsAction({ limit: 101 }), "validation_error");
  });
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

describe("timeline", () => {
  let events: ClientTimelineEvent[];

  beforeAll(async () => {
    as(ownerA);
    events = ok(
      await listClientTimelineAction({ clientId: c.lea, limit: 100 }),
    ).events;
  });

  it("holds the persisted history only, upcoming confirmed appointments apart", () => {
    expect(events.map((event) => event.id).sort()).toEqual(
      [
        ...[
          appt.leaCoupe1,
          appt.leaCoupe2,
          appt.leaCancelledSame,
          appt.leaCouleur1,
          appt.leaNoShow,
          appt.leaCouleur2,
          appt.leaPastConfirmed,
          // Cancelled: not upcoming, so in the history (at its start).
          appt.leaCancelledFuture,
        ].map((id) => `appointment:${id}`),
        ...[ev.loyaltyEarned, ev.loyaltyGift, ev.loyaltyRedeemed].map(
          (id) => `loyalty:${id}`,
        ),
        ...[
          ev.emailPending,
          ev.emailSent,
          ev.emailFailed,
          ev.emailSameInstant,
        ].map((id) => `email:${id}`),
      ].sort(),
    );
    expect(events.map((event) => event.id)).not.toContain(
      `appointment:${appt.leaNext}`,
    );
  });

  it("is ordered newest first, ties broken by event id", () => {
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1]!;
      const current = events[index]!;
      const ordered =
        previous.occurredAt.at > current.occurredAt.at ||
        (previous.occurredAt.at === current.occurredAt.at &&
          previous.id > current.id);
      expect(ordered).toBe(true);
    }
    // The email recorded at the very start of a visit: one instant, two
    // events, a fixed order.
    const same = events.filter((event) => event.occurredAt.at === at(-10));
    expect(same.map((event) => event.id)).toEqual([
      `email:${ev.emailSameInstant}`,
      `appointment:${appt.leaCouleur1}`,
    ]);
  });

  it("appointment events: their own recorded service, price and contact; completion time only when recorded", () => {
    const visit = events.find(
      (event) => event.id === `appointment:${appt.leaCouleur2}`,
    );
    expect(visit).toMatchObject({
      kind: "appointment",
      occurredAt: { at: at(-5) },
      appointment: {
        id: appt.leaCouleur2,
        status: "completed",
        startsAt: { at: at(-5) },
        service: { id: couleur, name: "Couleur", durationMinutes: 60 },
        price: { amountCents: 6000, currency: "EUR" },
        source: "public",
        completedAt: { at: plus(at(-5), 180) },
        contact: {
          firstName: "Léa",
          lastName: "Martin",
          email: "lea@example.test",
          phone: "06 12 34 56 78",
        },
      },
    });
    const older = events.find(
      (event) => event.id === `appointment:${appt.leaCoupe1}`,
    );
    expect(older).toMatchObject({ appointment: { completedAt: null } });
  });

  it("loyalty: one event per ledger entry, a redemption inside its entry (never a second event)", () => {
    const entries = events.filter((event) => event.kind === "loyalty");
    expect(entries).toHaveLength(3);
    const redeemed = entries.find(
      (event) => event.id === `loyalty:${ev.loyaltyRedeemed}`,
    );
    expect(redeemed).toMatchObject({
      entry: {
        type: "reward_redeemed",
        pointsDelta: -4,
        redemption: { rewardName: "Soin offert", pointsSpent: 4 },
      },
    });
    const earned = entries.find(
      (event) => event.id === `loyalty:${ev.loyaltyEarned}`,
    );
    expect(earned).toMatchObject({
      entry: {
        type: "appointment_completed",
        pointsDelta: 1,
        appointmentId: appt.leaCoupe1,
        redemption: null,
      },
    });
  });

  it("emails: a pending email is scheduled, never sent; no payload, provider id or error text", () => {
    const byId = (id: string) =>
      events.find((event) => event.id === `email:${id}`);
    expect(byId(ev.emailPending!)).toMatchObject({
      email: { status: "scheduled", sentAt: null, appointmentId: appt.leaNext },
    });
    expect(byId(ev.emailSent!)).toMatchObject({
      email: { status: "sent", sentAt: { at: at(-29, 11) } },
    });
    expect(byId(ev.emailFailed!)).toMatchObject({
      email: { status: "failed", sentAt: null },
    });
    const text = JSON.stringify(events);
    for (const secret of [
      "SECRET-PAYLOAD",
      "PROVIDER-ID-123",
      "SMTP-ERROR-TEXT",
      "delivered",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("history keeps the appointment's contact; the profile shows the current record", async () => {
    await db.query(
      "update public.clients set first_name = 'Léa-Marie', email = 'lea.new@example.test', phone = null where id = $1",
      [c.lea],
    );
    try {
      as(ownerA);
      const profile = ok(await getClientProfileAction({ clientId: c.lea }));
      expect(profile.client).toMatchObject({
        firstName: "Léa-Marie",
        email: "lea.new@example.test",
        phone: null,
      });
      const page = ok(
        await listClientTimelineAction({ clientId: c.lea, limit: 100 }),
      );
      const visit = page.events.find(
        (event) => event.id === `appointment:${appt.leaCoupe1}`,
      );
      expect(visit).toMatchObject({
        appointment: {
          contact: {
            firstName: "Léa",
            email: "lea@example.test",
            phone: "06 12 34 56 78",
          },
        },
      });
    } finally {
      await db.query(
        "update public.clients set first_name = 'Léa', email = 'lea@example.test', phone = '06 12 34 56 78' where id = $1",
        [c.lea],
      );
    }
  });

  it("pages of any size give the whole history once, in order", async () => {
    as(ownerA);
    for (const limit of [1, 2, 3, 5]) {
      const paged = await timeline(c.lea!, limit);
      expect(paged.events.map((event) => event.id)).toEqual(
        events.map((event) => event.id),
      );
      expect(paged.pages).toBe(Math.ceil(events.length / limit));
    }
  });

  it("an event recorded between two pages: no duplicate, no shift; the next first page shows it", async () => {
    const client = await customer(A.id, { firstName: "Feed" });
    for (let day = 1; day <= 12; day += 1) {
      await appointment(A.id, client, coupe, at(-day, 16), "completed");
    }
    as(ownerA);
    const first = ok(
      await listClientTimelineAction({ clientId: client, limit: 5 }),
    );
    const fresh = await email(A.id, client, {
      createdAt: new Date().toISOString(),
    });
    const rest: ClientTimelineEvent[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = ok(
        await listClientTimelineAction({ clientId: client, limit: 5, cursor }),
      );
      rest.push(...page.events);
      cursor = page.nextCursor;
    }
    const seen = [...first.events, ...rest].map((event) => event.id);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen).not.toContain(`email:${fresh}`);
    const again = ok(
      await listClientTimelineAction({ clientId: client, limit: 5 }),
    );
    expect(again.events[0]!.id).toBe(`email:${fresh}`);
  });

  it("is bounded: a page never exceeds its limit, and the limit is capped", async () => {
    as(ownerA);
    const page = ok(
      await listClientTimelineAction({ clientId: c.lea, limit: 4 }),
    );
    expect(page.events).toHaveLength(4);
    failure(
      await listClientTimelineAction({ clientId: c.lea, limit: 101 }),
      "validation_error",
    );
  });
});

// ---------------------------------------------------------------------------
// Business time
// ---------------------------------------------------------------------------

/** Next first Sunday of November (Vancouver falls back at 02:00 PDT). */
function nextFallBack(): string {
  const now = new Date();
  for (let year = now.getUTCFullYear(); ; year += 1) {
    const day = new Date(Date.UTC(year, 10, 1));
    while (day.getUTCDay() !== 0) day.setUTCDate(day.getUTCDate() + 1);
    if (day.getTime() > now.getTime() + 2 * DAY) {
      return day.toISOString().slice(0, 10);
    }
  }
}

describe("business time zone", () => {
  let owner: Professional;
  let business: TestBusiness;
  let service: string;
  let client: string;

  beforeAll(async () => {
    owner = await createProfessional("crm-tz");
    business = await createBusiness(owner.userId, {
      timezone: "America/Vancouver",
    });
    service = await createService(business.id, { durationMinutes: 30 });
    client = await customer(business.id, { firstName: "Maya" });
  });

  it("wall clocks come from the business time zone, not the server's (UTC)", async () => {
    const { rows } = await db.query<{
      midnight: Date;
      late: Date;
      day: string;
    }>(
      `select (d::timestamp at time zone 'America/Vancouver') as midnight,
              ((d + interval '23 hours 30 minutes')::timestamp at time zone 'America/Vancouver') as late,
              d::text as day
       from (select (now() at time zone 'America/Vancouver')::date - 20 as d) x`,
    );
    const { midnight, late, day } = rows[0]!;
    await appointment(
      business.id,
      client,
      service,
      midnight.toISOString(),
      "completed",
      30,
    );
    await appointment(
      business.id,
      client,
      service,
      late.toISOString(),
      "completed",
      30,
    );

    as(owner);
    const page = ok(await listClientTimelineAction({ clientId: client }));
    const locals = page.events.map((event) => event.occurredAt.local).sort();
    // 23:30 in Vancouver is already the next day in UTC: grouped by the
    // business's own date.
    expect(locals).toEqual([`${day}T00:00`, `${day}T23:30`]);
    expect(late.toISOString().slice(0, 10)).not.toBe(day);
    expect(page.timezone).toBe("America/Vancouver");
  });

  it("the repeated autumn hour: two appointments at 01:30, first and second occurrence", async () => {
    const date = nextFallBack();
    // 01:30 PDT (UTC−7) then 01:30 PST (UTC−8).
    const first = `${date}T08:30:00.000Z`;
    const second = `${date}T09:30:00.000Z`;
    await appointment(business.id, client, service, first, "confirmed", 30);
    await appointment(business.id, client, service, second, "confirmed", 30);
    as(owner);
    const profile = ok(await getClientProfileAction({ clientId: client }));
    expect(
      profile.upcoming.map((row) => [
        row.startsAt.local,
        row.startsAt.occurrence,
      ]),
    ).toEqual([
      [`${date}T01:30`, "first"],
      [`${date}T01:30`, "second"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reads never write
// ---------------------------------------------------------------------------

describe("read paths", () => {
  it("never change appointments, customers, loyalty, emails or calendar mirrors", async () => {
    const state = async () => {
      const { rows } = await db.query(
        `select
           (select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) from public.appointments a where a.business_id = $1) as appointments,
           (select md5(coalesce(string_agg(c::text, '|' order by c.id), '')) from public.clients c where c.business_id = $1) as clients,
           (select md5(coalesce(string_agg(l::text, '|' order by l.id), '')) from public.loyalty_events l where l.business_id = $1) as loyalty,
           (select md5(coalesce(string_agg(e::text, '|' order by e.id), '')) from public.email_events e where e.business_id = $1) as emails,
           (select count(*)::int from private.appointment_calendar_mirrors m where m.business_id = $1) as mirrors`,
        [A.id],
      );
      return rows[0];
    };
    const before = await state();
    as(ownerA);
    for (const sort of [
      "name",
      "newest",
      "last_visit",
      "next_appointment",
      "most_visits",
    ] as const) {
      await allPages({ sort }, 2);
    }
    for (const id of [c.lea!, c.emma!, c.zoe!, c.ines!]) {
      ok(await getClientProfileAction({ clientId: id }));
      await timeline(id, 3);
    }
    expect(await state()).toEqual(before);
    const { rows } = await db.query(
      `select p.proname, p.provolatile from pg_proc p
       where p.proname like 'crm\\_%' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows.every((row) => row.provolatile === "s")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe("performance with thousands of customers", () => {
  let owner: Professional;
  let business: TestBusiness;
  let heavy: string;

  beforeAll(async () => {
    owner = await createProfessional("crm-perf");
    business = await createBusiness(owner.userId, { timezone: "Europe/Paris" });
    const service = await createService(business.id, { durationMinutes: 30 });
    await db.query(
      `insert into public.clients (business_id, first_name, last_name, email, phone)
       select $1, 'Cliente' || g, 'Nom' || g, 'c' || g || '@perf.test', '06' || lpad(g::text, 8, '0')
       from generate_series(1, 3000) g`,
      [business.id],
    );
    // 5 appointments per customer, one hour apart, from 400 days ago.
    await db.query(
      `insert into public.appointments (
         business_id, client_id, service_id, starts_at, ends_at, status,
         service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, buffer_minutes_snapshot
       )
       select $1, c.id, $2, s.at, s.at + interval '30 minutes',
              (case when s.at > now() then 'confirmed'
                    else (array['completed','completed','cancelled','no_show','confirmed'])[1 + s.n % 5]
               end)::public.appointment_status,
              'Soin', 30, 5000, 0
       from (select c.id, row_number() over (order by c.id) as r
             from public.clients c where c.business_id = $1) c
       cross join lateral (
         select k as n, now() - interval '400 days' + ((c.r - 1) * 5 + k) * interval '1 hour' as at
         from generate_series(0, 4) k
       ) s`,
      [business.id, service],
    );
    heavy = (
      await db.query<{ id: string }>(
        "select id from public.clients where business_id = $1 order by created_at, id limit 1",
        [business.id],
      )
    ).rows[0]!.id;
    // 20 000 emails in the business, 2 000 of them for one customer.
    await db.query(
      `insert into public.email_events (business_id, client_id, type, recipient_email, dedupe_key, created_at)
       select $1, case when g <= 2000 then $2 else c.id end, 'booking_confirmation', 'x@perf.test',
              'perf-' || g, now() - g * interval '1 minute'
       from generate_series(1, 20000) g
       cross join lateral (
         select id from public.clients where business_id = $1 offset (g % 3000) limit 1
       ) c`,
      [business.id, heavy],
    );
    await db.query(
      "analyze public.clients, public.appointments, public.email_events",
    );
  });

  async function timed<T>(run: () => Promise<T>) {
    const start = performance.now();
    const result = await run();
    return { result, ms: performance.now() - start };
  }

  it("directory pages over 3 000 customers and 15 000 appointments stay fast, every ordering", async () => {
    as(owner);
    for (const sort of [
      "name",
      "last_visit",
      "next_appointment",
      "most_visits",
    ] as const) {
      const { result, ms } = await timed(() =>
        listClientsAction({ sort, limit: 25 }),
      );
      const page = ok(result);
      expect(page.totalCount).toBe(3000);
      expect(page.clients).toHaveLength(25);
      expect(ms).toBeLessThan(3000);
    }
    const { result, ms } = await timed(() =>
      listClientsAction({ query: "Cliente12", limit: 25 }),
    );
    expect(ok(result).totalCount).toBe(111);
    expect(ms).toBeLessThan(3000);
  });

  it("a timeline page of a customer with 2 000 emails is bounded and uses the customer index", async () => {
    as(owner);
    const { result, ms } = await timed(() =>
      listClientTimelineAction({ clientId: heavy, limit: 20 }),
    );
    const page = ok(result);
    expect(page.events).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    expect(ms).toBeLessThan(3000);

    const { rows } = await db.query(
      `explain (format json)
       select e.id from public.email_events e
       where e.business_id = $1 and e.client_id = $2
       order by e.created_at desc limit 21`,
      [business.id, heavy],
    );
    expect(JSON.stringify(rows[0])).toContain(
      "email_events_client_timeline_idx",
    );
  });
});
