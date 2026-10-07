import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GET as oauthCallback } from "@/app/api/calendar/google/callback/route";
import {
  disableCalendarOutboundAction,
  enableCalendarOutboundAction,
  getCalendarOutboundStatusAction,
  reactivateCalendarOutboundAction,
  startGoogleCalendarConnectAction,
  startGoogleCalendarWriteAuthorizationAction,
} from "@/features/calendar/actions/calendar";
import {
  createManualAppointment,
  setAppointmentStatus,
  updateAppointment,
} from "@/features/agenda/data/appointments";
import { runCalendarJob } from "@/features/calendar/data/cron";
import { getCalendarDeps } from "@/features/calendar/data/deps";
import {
  ensureOutboundCalendar,
  processOutbound,
} from "@/features/calendar/data/outbound";
import {
  backfillOutbound,
  reconcileOutbound,
} from "@/features/calendar/data/reconcile";
import type { ActionResult } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import { FakeGoogle, pageOffsetOf } from "../support/fake-google";
import {
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
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  blockingPids,
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
} from "./support/transactions";

// Outbound backfill, drift detection and reconciliation (periodic job).
// Google is the in-memory FakeGoogle reached through the real adapter; SQL
// functions, triggers, locks and Server Actions are real. Each test keeps
// its own business the only enrolled one, so that runs of the periodic
// job's outbound part see nothing else.

let sessionClient: AppSupabaseClient;
const background: (() => Promise<unknown>)[] = [];
const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => admin,
}));
vi.mock("@/features/calendar/data/background", () => ({
  runAfterResponse: (_operation: string, task: () => Promise<unknown>) => {
    background.push(task);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

let fake: FakeGoogle;
const realFetch = globalThis.fetch;

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY =
    randomBytes(32).toString("base64");
  process.env.CRON_SECRET = "c".repeat(40);
  delete process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
});

beforeEach(() => {
  fake = new FakeGoogle();
  process.env.GOOGLE_CALENDAR_CLIENT_ID = fake.clientId;
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = fake.clientSecret;
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      return /(^|\.)googleapis\.com$|^accounts\.google\.com$/.test(url.host)
        ? fake.fetch(input, init)
        : realFetch(input as RequestInfo, init);
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  background.length = 0;
});

async function flush() {
  while (background.length > 0) {
    const tasks = background.splice(0);
    await Promise.all(tasks.map((task) => task()));
  }
}

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${result.error.code}`);
  return result.data;
}

const D = dateInDays(10);
const at = (date: string, time: string) => `${date}T${time}:00.000Z`;
const instant = (value: string | undefined) => new Date(value!).toISOString();

type Account = { sub: string; email: string };
type Setup = {
  owner: Professional;
  business: TestBusiness;
  service: string;
  account: Account;
};

/** A Google account with its personal calendar. */
function newAccount(): Account {
  const account = {
    sub: `sub-${randomUUID()}`,
    email: `${randomUUID().slice(0, 6)}@gmail.test`,
  };
  fake.addCalendar(account.sub, {
    id: account.email,
    summary: "Personnel",
    timeZone: "UTC",
  });
  return account;
}

async function setup(account?: Account): Promise<Setup> {
  const owner = await createProfessional("reconcile");
  const business = await createBusiness(owner.userId, {
    name: `Studio ${randomUUID().slice(0, 6)}`,
    timezone: "UTC",
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
    },
  });
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
  const service = await createService(business.id, {
    name: "Coupe",
    durationMinutes: 60,
  });
  return { owner, business, service, account: account ?? newAccount() };
}

function callbackRequest(query: Record<string, string>) {
  const url = new URL("http://localhost:3000/api/calendar/google/callback");
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  return new NextRequest(url);
}

const resultOf = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get("calendar");

async function connect(s: Setup, account = s.account) {
  sessionClient = s.owner.client;
  const { authorizationUrl } = ok(await startGoogleCalendarConnectAction());
  const { code, state } = fake.authorize(account, authorizationUrl);
  expect(resultOf(await oauthCallback(callbackRequest({ state, code })))).toBe(
    "connected",
  );
  background.length = 0;
}

async function authorizeWrite(s: Setup, account = s.account) {
  sessionClient = s.owner.client;
  const { authorizationUrl } = ok(
    await startGoogleCalendarWriteAuthorizationAction(),
  );
  const { code, state } = fake.authorize(account, authorizationUrl);
  return resultOf(await oauthCallback(callbackRequest({ state, code })));
}

/** Connected, write authorized, dedicated calendar created and adopted. */
async function enabled(s: Setup) {
  await connect(s);
  expect(await authorizeWrite(s)).toBe("write_authorized");
  await flush();
  return (await outboundRow(s)).provider_calendar_id!;
}

/** Only these businesses are enrolled (others' leftovers stay out). */
async function only(...setups: Setup[]) {
  await db.query(
    `update private.calendar_outbound
     set status = 'disabled', action_code = null, provider_calendar_id = null,
         generation = gen_random_uuid()
     where not (business_id = any ($1::uuid[])) and status <> 'disabled'`,
    [setups.map((s) => s.business.id)],
  );
}

/** The background kick after a change (writer only). */
const run = (s: Setup) =>
  processOutbound(getCalendarDeps(), { businessId: s.business.id });

/** The periodic job's outbound part: creations, backfill, writes, reconciliation. */
const maintain = (budgetMs = 25_000) =>
  processOutbound(getCalendarDeps(), { budgetMs });

const reconcile = (options: { maxPages?: number } = {}) =>
  reconcileOutbound(getCalendarDeps(), {
    deadline: Date.now() + 20_000,
    ...options,
  });

async function outboundRow(s: Setup) {
  const { rows } = await db.query(
    "select * from private.calendar_outbound where business_id = $1",
    [s.business.id],
  );
  return rows[0] as {
    status: string;
    generation: string;
    provider_calendar_id: string | null;
    action_code: string | null;
    backfill_next_at: Date | null;
  };
}

type ReconRow = {
  provider_calendar_id: string;
  sync_token: string | null;
  page_token: string | null;
  scan_id: string | null;
  next_reconcile_at: Date;
  claim_id: string | null;
  attempts: number;
  last_error: string | null;
};

async function recon(s: Setup) {
  const { rows } = await db.query(
    "select * from private.calendar_outbound_reconciliation where business_id = $1",
    [s.business.id],
  );
  return rows[0] as ReconRow | undefined;
}

/** The next listing of this business is due now. */
async function due(s: Setup) {
  await db.query(
    "update private.calendar_outbound_reconciliation set next_reconcile_at = now() where business_id = $1",
    [s.business.id],
  );
}

type MirrorRow = {
  desired_revision: string;
  applied_revision: string;
  repair_generation: string;
  repaired_generation: string;
  attempts: number;
  provider_calendar_id: string | null;
  applied_at: Date | null;
};

async function mirror(appointmentId: string) {
  const { rows } = await db.query(
    "select * from private.appointment_calendar_mirrors where appointment_id = $1",
    [appointmentId],
  );
  return rows[0] as MirrorRow | undefined;
}

const repairDue = (row: MirrorRow | undefined) =>
  Number(row!.repair_generation) > Number(row!.repaired_generation);

async function createAppointment(
  s: Setup,
  time: string,
  date = D,
  firstName = "Léa",
) {
  const created = await createManualAppointment(
    s.owner.client,
    { businessId: s.business.id, timezone: "UTC" },
    {
      date,
      time,
      occurrence: undefined,
      serviceId: s.service,
      client: {
        type: "new",
        firstName,
        lastName: "Martin",
        email: `${randomUUID().slice(0, 6)}@client.test`,
        phone: "+33600000000",
      },
      internalNotes: "Note interne confidentielle",
      requestId: randomUUID(),
    },
  );
  return created.appointment;
}

async function appointmentRow(id: string) {
  const { rows } = await db.query(
    "select id, version, client_id from public.appointments where id = $1",
    [id],
  );
  return rows[0] as { id: string; version: number; client_id: string };
}

async function reschedule(s: Setup, id: string, time: string) {
  const row = await appointmentRow(id);
  await updateAppointment(
    s.owner.client,
    { businessId: s.business.id, timezone: "UTC" },
    {
      appointmentId: id,
      expectedVersion: row.version,
      date: D,
      time,
      occurrence: undefined,
      serviceId: s.service,
      clientId: row.client_id,
      internalNotes: null,
    },
  );
}

async function cancel(s: Setup, id: string) {
  const row = await appointmentRow(id);
  await setAppointmentStatus(
    s.owner.client,
    { businessId: s.business.id, timezone: "UTC" },
    {
      appointmentId: id,
      expectedVersion: row.version,
      status: "cancelled",
      cancellationReason: "Annulé",
    },
  );
}

const eventIdOf = (appointmentId: string) =>
  `bk${appointmentId.replace(/-/g, "")}`;

function storedEvent(calendarId: string, appointmentId: string) {
  return fake
    .storedEvents(calendarId)
    .find((event) => event.id === eventIdOf(appointmentId));
}

const isListing = (url: URL, method: string) =>
  method === "GET" &&
  /\/events$/.test(url.pathname) &&
  url.searchParams.get("showDeleted") === "true";
const isListingUrl = (url: URL) => isListing(url, "GET");
const isWrite = (url: URL, method: string) =>
  url.pathname.startsWith("/calendar/v3/calendars") && method !== "GET";
const googleWrites = () => fake.count(isWrite);
const listings = () => fake.count(isListing);
const providerCalls = () =>
  fake.count((url) => url.host === "www.googleapis.com");

/** The event exactly as Booking writes it (Booking-owned fields). */
function expectCanonical(
  calendarId: string,
  appointmentId: string,
  time = "10:00",
) {
  const event = storedEvent(calendarId, appointmentId)!;
  expect(event).toBeDefined();
  expect(event.status).toBe("confirmed");
  expect(event.summary).toBe("Léa — Coupe");
  expect(event.transparency).toBe("opaque");
  expect(instant(event.start.dateTime)).toBe(at(D, time));
  expect(event.start.date).toBeUndefined();
  expect(event.extendedProperties?.private).toMatchObject({
    origin: "booking-saas",
    appointmentId,
  });
}

/** A business with one written event and a complete first listing. */
async function reconciled(time = "10:00") {
  const s = await setup();
  const calendarId = await enabled(s);
  await only(s);
  const a = await createAppointment(s, time);
  await run(s);
  expect(await reconcile()).toMatchObject({ reconciled: 1, drifted: 0 });
  expect((await recon(s))?.sync_token).toEqual(expect.any(String));
  await due(s);
  return { s, calendarId, a };
}

// ---------------------------------------------------------------------------

describe("backfill", () => {
  it("enrolls appointments existing before the first activation, from the periodic job only: never ended or cancelled ones", async () => {
    const s = await setup();
    await connect(s);
    const future = await createAppointment(s, "10:00");
    const cancelled = await createAppointment(s, "12:00");
    await cancel(s, cancelled.id);
    const client = await createClientRecord(s.business.id, "old@client.test");
    const ended = await insertAppointment({
      businessId: s.business.id,
      clientId: client,
      serviceId: s.service,
      startsAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() - 3 * 86_400_000 + 3_600_000).toISOString(),
    });

    expect(await authorizeWrite(s)).toBe("write_authorized");
    // The enabling transaction and the kick that follows enroll nothing.
    await flush();
    await only(s);
    expect(await mirror(future.id)).toBeUndefined();
    const calendarId = (await outboundRow(s)).provider_calendar_id!;

    const result = await maintain();
    expect(result.backfilled).toBe(1);
    expect(await mirror(future.id)).toMatchObject({ applied_revision: "1" });
    expectCanonical(calendarId, future.id);
    expect(await mirror(cancelled.id)).toBeUndefined();
    expect(await mirror(ended)).toBeUndefined();
    expect(fake.storedEvents(calendarId).map((event) => event.id)).toEqual([
      eventIdOf(future.id),
    ]);
  });

  it("appointments created while outbound was disabled are enrolled after it is enabled again, never while disabled", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await only(s);
    sessionClient = s.owner.client;
    ok(await disableCalendarOutboundAction());
    const a = await createAppointment(s, "11:00");
    const calls = providerCalls();
    expect(await maintain()).toMatchObject({ backfilled: 0, applied: 0 });
    expect(await mirror(a.id)).toBeUndefined();
    expect(providerCalls()).toBe(calls);

    sessionClient = s.owner.client;
    ok(await enableCalendarOutboundAction());
    await flush();
    expect((await outboundRow(s)).backfill_next_at).toBeNull();
    await maintain();
    expect((await outboundRow(s)).provider_calendar_id).toBe(calendarId);
    expectCanonical(calendarId, a.id, "11:00");
  });

  it("bounded and deterministic: soonest end first, batch after batch, then idle for hours", async () => {
    const s = await setup();
    await connect(s);
    const times = ["15:00", "09:00", "13:00", "11:00", "17:00"];
    const ids = new Map<string, string>();
    for (const time of times)
      ids.set(time, (await createAppointment(s, time)).id);
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);

    const batch = () =>
      db.query("select public.calendar_outbound_backfill(5, 2) as result");
    const enrolled = async () => {
      const { rows } = await db.query<{ appointment_id: string }>(
        "select appointment_id from private.appointment_calendar_mirrors where business_id = $1",
        [s.business.id],
      );
      return new Set(rows.map((row) => row.appointment_id));
    };
    await batch();
    expect(await enrolled()).toEqual(
      new Set([ids.get("09:00"), ids.get("11:00")]),
    );
    expect(
      (await outboundRow(s)).backfill_next_at!.getTime(),
    ).toBeLessThanOrEqual(Date.now() + 1000);
    await batch();
    await batch();
    expect((await enrolled()).size).toBe(5);
    // Nothing left: the next check is hours away; a run enrolls nothing.
    expect((await outboundRow(s)).backfill_next_at!.getTime()).toBeGreaterThan(
      Date.now() + 5 * 3_600_000,
    );
    const { rows } = await db.query(
      "select public.calendar_outbound_backfill(5, 2) as result",
    );
    expect(rows[0].result).toMatchObject({ enrolled: 0 });
  });

  it("enrolled while the dedicated calendar is still being created: written once it exists", async () => {
    const s = await setup();
    await connect(s);
    const a = await createAppointment(s, "10:00");
    // The first creation attempt is refused: outbound stays creating.
    fake.failNext((url) => url.pathname === "/calendar/v3/calendars", 400, 1, {
      error: { code: 400 },
    });
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);
    expect((await outboundRow(s)).status).toBe("creating");
    expect(await backfillOutbound(getCalendarDeps())).toBe(1);
    expect(await mirror(a.id)).toMatchObject({ provider_calendar_id: null });

    await db.query(
      "update private.calendar_outbound set creation_next_attempt_at = null where business_id = $1",
      [s.business.id],
    );
    expect(await maintain()).toMatchObject({ creations: 1, applied: 1 });
    const calendarId = (await outboundRow(s)).provider_calendar_id!;
    expectCanonical(calendarId, a.id);
  });

  it("action required: enrolled locally, no provider call; disabled: nothing", async () => {
    const s = await setup();
    await connect(s);
    const a = await createAppointment(s, "10:00");
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);
    await db.query(
      `update private.calendar_outbound
       set status = 'action_required', action_code = 'calendar_deleted',
           generation = gen_random_uuid(), provider_calendar_id = null
       where business_id = $1`,
      [s.business.id],
    );
    const calls = providerCalls();
    expect(await backfillOutbound(getCalendarDeps())).toBe(1);
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "0" });
    await maintain();
    expect(providerCalls()).toBe(calls);
  });

  it("two backfills at once: the second skips the business being enrolled; never a duplicate", async () => {
    const s = await setup();
    await connect(s);
    await createAppointment(s, "10:00");
    await createAppointment(s, "12:00");
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);

    const first = await openTransaction();
    await first.connection.query(
      "select public.calendar_outbound_backfill(5, 100)",
    );
    const { rows } = await db.query(
      "select public.calendar_outbound_backfill(5, 100) as result",
    );
    expect(rows[0].result).toMatchObject({ businesses: 0, enrolled: 0 });
    await closeTransaction(first, "commit");
    const { rows: count } = await db.query(
      "select count(*)::int as n from private.appointment_calendar_mirrors where business_id = $1",
      [s.business.id],
    );
    expect(count[0].n).toBe(2);
  });

  it("an appointment cancelled while the backfill enrolls it: the trigger waits, the newer revision wins, nothing is written", async () => {
    const s = await setup();
    await connect(s);
    const a = await createAppointment(s, "10:00");
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);

    const enrolling = await openTransaction();
    await enrolling.connection.query(
      "select public.calendar_outbound_backfill(5, 100)",
    );
    const cancelling = await openTransaction();
    const cancelled = outcome(
      cancelling.connection.query(
        "update public.appointments set status = 'cancelled', cancellation_reason = 'x' where id = $1",
        [a.id],
      ),
    );
    await waitUntilBlocked(cancelling.pid);
    expect(await blockingPids(cancelling.pid)).toContain(enrolling.pid);
    await closeTransaction(enrolling, "commit");
    expect(await cancelled).toBe("ok");
    await closeTransaction(cancelling, "commit");

    expect(await mirror(a.id)).toMatchObject({ desired_revision: "2" });
    const writes = googleWrites();
    await run(s);
    expect(googleWrites()).toBe(writes);
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "2" });
  });

  it("a disable during a backfill waits for it; the enrolled mirrors then follow the disabled outbound (no call)", async () => {
    const s = await setup();
    await connect(s);
    const a = await createAppointment(s, "10:00");
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);

    const enrolling = await openTransaction();
    await enrolling.connection.query(
      "select public.calendar_outbound_backfill(5, 100)",
    );
    const disabling = await openTransaction({
      role: "authenticated",
      userId: s.owner.userId,
    });
    const disabled = outcome(
      disabling.connection.query(
        "select public.calendar_outbound_disable($1)",
        [s.business.id],
      ),
    );
    await waitUntilBlocked(disabling.pid);
    await closeTransaction(enrolling, "commit");
    expect(await disabled).toBe("ok");
    await closeTransaction(disabling, "commit");

    expect((await outboundRow(s)).status).toBe("disabled");
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "0" });
    const calls = providerCalls();
    await maintain();
    expect(providerCalls()).toBe(calls);
  });
});

// ---------------------------------------------------------------------------

describe("drift detection", () => {
  it("first listing: a full scan, then incremental; nothing differs, nothing is written; inbound never sees it", async () => {
    const { s, calendarId, a } = await reconciled();
    expect((await recon(s))!.provider_calendar_id).toBe(calendarId);
    const writes = googleWrites();
    expect(await reconcile()).toMatchObject({ reconciled: 1, drifted: 0 });
    expect(googleWrites()).toBe(writes);
    expect(repairDue(await mirror(a.id))).toBe(false);
    const { rows } = await db.query(
      "select count(*)::int as n from public.external_calendar_events where business_id = $1",
      [s.business.id],
    );
    expect(rows[0].n).toBe(0);
    // Incremental: the request carries the stored sync token.
    const last = fake.requests.filter((request) =>
      isListing(request.url, request.method),
    );
    expect(last.at(-1)!.url.searchParams.get("syncToken")).toMatch(/^sync-/);
  });

  const edits: [string, (calendarId: string, eventId: string) => void][] = [
    ["title changed", (c, e) => fake.editEvent(c, e, { summary: "Autre" })],
    [
      "start moved",
      (c, e) => fake.editEvent(c, e, { start: { dateTime: at(D, "09:00") } }),
    ],
    [
      "end moved",
      (c, e) => fake.editEvent(c, e, { end: { dateTime: at(D, "12:00") } }),
    ],
    [
      "made free (transparent)",
      (c, e) => fake.editEvent(c, e, { transparency: "transparent" }),
    ],
    [
      "turned all-day",
      (c, e) => fake.editEvent(c, e, { start: { date: D }, end: { date: D } }),
    ],
    ["tentative", (c, e) => fake.editEvent(c, e, { status: "tentative" })],
    [
      "identifying metadata altered",
      (c, e) =>
        fake.editEvent(c, e, {
          extendedProperties: {
            private: { origin: "booking-saas", appointmentId: randomUUID() },
          },
        }),
    ],
    [
      "metadata removed",
      (c, e) => fake.editEvent(c, e, { extendedProperties: { private: {} } }),
    ],
    ["deleted in Google", (c, e) => fake.deleteEvent(c, e)],
  ];

  it.each(edits)(
    "%s: recorded as a repair (not a revision), the normal writer restores the event",
    async (_label, edit) => {
      const { s, calendarId, a } = await reconciled();
      edit(calendarId, eventIdOf(a.id));
      expect(await reconcile()).toMatchObject({ drifted: 1 });
      const flagged = (await mirror(a.id))!;
      expect(flagged).toMatchObject({
        desired_revision: "1",
        applied_revision: "1",
      });
      expect(repairDue(flagged)).toBe(true);
      // Repairs are pending changes for the professional.
      sessionClient = s.owner.client;
      expect(ok(await getCalendarOutboundStatusAction())).toMatchObject({
        health: "pending",
        pendingCount: 1,
      });

      await run(s);
      expectCanonical(calendarId, a.id);
      expect(repairDue(await mirror(a.id))).toBe(false);
      // The repair is seen once more by the incremental listing: no drift.
      await due(s);
      expect(await reconcile()).toMatchObject({ drifted: 0 });
    },
  );

  const unchanged: [string, (calendarId: string, eventId: string) => void][] = [
    [
      "the same instants in another offset",
      (c, e) =>
        fake.editEvent(c, e, {
          start: { dateTime: `${D}T12:00:00+02:00` },
          end: { dateTime: `${D}T06:00:00-05:00` },
        }),
    ],
    [
      "the same instants with milliseconds and Z",
      (c, e) =>
        fake.editEvent(c, e, {
          start: { dateTime: `${D}T10:00:00.000Z` },
          end: { dateTime: `${D}T11:00:00.000Z` },
        }),
    ],
    [
      "a time zone named next to the offset",
      (c, e) =>
        fake.editEvent(c, e, {
          start: { dateTime: `${D}T10:00:00Z`, timeZone: "Europe/Paris" },
        }),
    ],
    [
      "fields Booking never writes (description, colour)",
      (c, e) => fake.editEvent(c, e, { description: "Note", colorId: "3" }),
    ],
    [
      "the informational revision",
      (c, e) =>
        fake.editEvent(c, e, {
          extendedProperties: {
            private: {
              ...storedEventById(c, e)!.extendedProperties!.private,
              revision: "99",
            },
          },
        }),
    ],
  ];

  function storedEventById(calendarId: string, eventId: string) {
    return fake.storedEvents(calendarId).find((event) => event.id === eventId);
  }

  it.each(unchanged)("%s: no drift, nothing written", async (_label, edit) => {
    const { calendarId, a } = await reconciled();
    edit(calendarId, eventIdOf(a.id));
    const writes = googleWrites();
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    expect(repairDue(await mirror(a.id))).toBe(false);
    expect(googleWrites()).toBe(writes);
  });

  it("cancelled in Booking, recreated in Google: removed again; cancelled in Booking and deleted in Google: never resurrected", async () => {
    const { s, calendarId, a } = await reconciled();
    const b = await createAppointment(s, "14:00");
    await run(s);
    await cancel(s, a.id);
    await cancel(s, b.id);
    await run(s);
    expect(storedEvent(calendarId, a.id)!.status).toBe("cancelled");
    await due(s);
    await reconcile();
    await due(s);

    // a: the professional restores it in Google; b stays deleted.
    fake.editEvent(calendarId, eventIdOf(a.id), { status: "confirmed" });
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    expect(repairDue(await mirror(a.id))).toBe(true);
    expect(repairDue(await mirror(b.id))).toBe(false);
    await run(s);
    expect(storedEvent(calendarId, a.id)!.status).toBe("cancelled");
    expect(storedEvent(calendarId, b.id)!.status).toBe("cancelled");
  });

  it("an event in the target for an appointment cancelled before any write (none recorded there): the repair removes it", async () => {
    const { s, calendarId } = await reconciled();
    const c = await createAppointment(s, "16:00");
    await cancel(s, c.id);
    await run(s);
    expect(await mirror(c.id)).toMatchObject({ provider_calendar_id: null });
    expect(storedEvent(calendarId, c.id)).toBeUndefined();
    // Present in Google anyway (with the deterministic id).
    fake.putEvent(calendarId, {
      id: eventIdOf(c.id),
      summary: "Léa — Coupe",
      start: { dateTime: at(D, "16:00") },
      end: { dateTime: at(D, "17:00") },
    });
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    await run(s);
    expect(storedEvent(calendarId, c.id)!.status).toBe("cancelled");
  });

  it("events of no mirror of this business are ignored: the professional's own, look-alike ids, another business's", async () => {
    const { s, calendarId, a } = await reconciled();
    const other = await setup();
    await enabled(other);
    await only(s, other);
    const foreign = await createAppointment(other, "10:00");
    for (const event of [
      { id: "ownevent12345", summary: "Dentiste" },
      { id: eventIdOf(randomUUID()), summary: "Inconnu" },
      { id: `bkprobe${randomUUID().replace(/-/g, "")}`, summary: "Booking" },
      { id: eventIdOf(foreign.id), summary: "Pas d'ici" },
    ]) {
      fake.putEvent(calendarId, {
        ...event,
        start: { dateTime: at(D, "18:00") },
        end: { dateTime: at(D, "19:00") },
      });
    }
    const writes = googleWrites();
    await due(s);
    const result = await reconcile();
    expect(result.drifted).toBe(0);
    expect(googleWrites()).toBe(writes);
    expect(repairDue(await mirror(a.id))).toBe(false);
    expect(await mirror(foreign.id)).toMatchObject({ repair_generation: "0" });
    expect(fake.storedEvents(calendarId)).toHaveLength(5);
  });

  it("past appointments are history: never repaired", async () => {
    const { s, calendarId, a } = await reconciled();
    await db.query(
      `update public.appointments
       set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '1 hour'
       where id = $1`,
      [a.id],
    );
    await run(s);
    await due(s);
    await reconcile();
    await due(s);
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "Autre" });
    expect(await reconcile()).toMatchObject({ drifted: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("full scans", () => {
  it("an event Google no longer lists at all is found missing by a complete full scan (sync token gone: 410 → reset → full scan)", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.purgeEvent(calendarId, eventIdOf(a.id));
    // Incremental listings cannot see a purge.
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    await due(s);
    fake.expireSyncTokens();
    const writes = googleWrites();
    expect(await reconcile()).toMatchObject({ reconciled: 0, drifted: 0 });
    expect(await recon(s)).toMatchObject({ sync_token: null, scan_id: null });
    expect(repairDue(await mirror(a.id))).toBe(false);
    expect(googleWrites()).toBe(writes);

    expect(await reconcile()).toMatchObject({ reconciled: 1, drifted: 1 });
    expect(repairDue(await mirror(a.id))).toBe(true);
    await run(s);
    expectCanonical(calendarId, a.id);
  });

  it("a full scan that fails part-way decides nothing; resumed from its page, it completes and only then reports the missing event", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await only(s);
    const ids = [];
    for (const time of ["09:00", "11:00", "13:00", "15:00"]) {
      ids.push((await createAppointment(s, time)).id);
    }
    await run(s);
    fake.purgeEvent(calendarId, eventIdOf(ids[3]!));
    fake.pageSize = 1;
    fake.failNext(
      (url) => isListingUrl(url) && pageOffsetOf(url) === 2,
      503,
      4,
    );

    expect(await reconcile()).toMatchObject({ reconciled: 0, drifted: 0 });
    const failed = (await recon(s))!;
    expect(failed).toMatchObject({
      sync_token: null,
      page_token: expect.stringMatching(/^p\d+-2$/),
      attempts: 1,
      claim_id: null,
      last_error: "unavailable",
    });
    expect(failed.scan_id).not.toBeNull();
    expect(repairDue(await mirror(ids[3]!))).toBe(false);

    await due(s);
    expect(await reconcile()).toMatchObject({ reconciled: 1, drifted: 1 });
    expect((await recon(s))!.sync_token).toEqual(expect.any(String));
    expect(repairDue(await mirror(ids[3]!))).toBe(true);
    for (const id of ids.slice(0, 3)) {
      expect(repairDue(await mirror(id))).toBe(false);
    }
  });

  it("a long listing is bounded per run and resumes at the next one, under the same scan", async () => {
    const s = await setup();
    await enabled(s);
    await only(s);
    for (const time of ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"]) {
      await createAppointment(s, time);
    }
    await run(s);
    fake.pageSize = 1;
    expect(await reconcile({ maxPages: 4 })).toMatchObject({ reconciled: 0 });
    const paused = (await recon(s))!;
    expect(paused).toMatchObject({
      page_token: expect.stringMatching(/^p\d+-4$/),
      claim_id: null,
    });
    expect(paused.next_reconcile_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await reconcile({ maxPages: 4 })).toMatchObject({
      reconciled: 1,
      drifted: 0,
    });
    expect((await recon(s))!.scan_id).toBeNull();
  });

  it("a mirror written after the scan started is never reported missing; one written before is", async () => {
    const { s, a } = await reconciled();
    const b = await createAppointment(s, "14:00");
    await run(s);
    await db.query(
      "update private.calendar_outbound_reconciliation set sync_token = null where business_id = $1",
      [s.business.id],
    );
    const { rows } = await db.query(
      "select public.calendar_outbound_claim_reconciliation('{}') as claim",
    );
    const claim = rows[0].claim as { claimId: string; mode: string };
    expect(claim.mode).toBe("full");
    // b is written (again) after the scan started; neither was listed.
    await db.query(
      "update private.appointment_calendar_mirrors set applied_at = now() + interval '1 second' where appointment_id = $1",
      [b.id],
    );
    const { rows: page } = await db.query(
      "select public.calendar_outbound_reconciliation_page($1, $2, '[]', '{}', null, 'sync-x') as page",
      [s.business.id, claim.claimId],
    );
    expect(page[0].page).toEqual({ result: "done", repairs: 1 });
    expect(repairDue(await mirror(a.id))).toBe(true);
    expect(repairDue(await mirror(b.id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("provider failures", () => {
  const forbidden = (reason: string) => ({
    error: { code: 403, errors: [{ reason }] },
  });

  it.each([
    [
      "unavailable (5xx)",
      () => fake.failNext(isListingUrl, 503, 4),
      "unavailable",
    ],
    [
      "rate limited (429)",
      () => fake.failNext(isListingUrl, 429, 4),
      "rate_limited",
    ],
    [
      "quota (403 rateLimitExceeded)",
      () => fake.failNext(isListingUrl, 403, 1, forbidden("rateLimitExceeded")),
      "rate_limited",
    ],
    [
      "answer lost",
      () => fake.loseAnswer((url, method) => isListing(url, method), 4),
      "unavailable",
    ],
    [
      "malformed page",
      () => fake.failNext(isListingUrl, 200, 1, { items: "nope" }),
      "protocol",
    ],
  ])(
    "%s: backoff, the cursor is kept, outbound stays active",
    async (_label, inject, code) => {
      const { s, calendarId, a } = await reconciled();
      const token = (await recon(s))!.sync_token;
      fake.editEvent(calendarId, eventIdOf(a.id), { summary: "Autre" });
      inject();
      const writes = googleWrites();
      expect(await reconcile()).toMatchObject({ reconciled: 0, drifted: 0 });
      const row = (await recon(s))!;
      expect(row).toMatchObject({
        sync_token: token,
        attempts: 1,
        claim_id: null,
        last_error: code,
      });
      expect(row.next_reconcile_at.getTime()).toBeGreaterThan(Date.now());
      expect((await outboundRow(s)).status).toBe("active");
      expect(repairDue(await mirror(a.id))).toBe(false);
      expect(googleWrites()).toBe(writes);
      // Not due again before its backoff: no listing.
      const before = listings();
      await reconcile();
      expect(listings()).toBe(before);
    },
  );

  it("a real 403: one action required (write authorization) for the whole configuration", async () => {
    const { s, a } = await reconciled();
    fake.failNext(isListingUrl, 403, 1, forbidden("insufficientPermissions"));
    expect(await reconcile()).toMatchObject({ actionRequired: 1 });
    expect(await outboundRow(s)).toMatchObject({
      status: "action_required",
      action_code: "write_authorization_required",
    });
    const calls = providerCalls();
    await run(s);
    await reconcile();
    expect(providerCalls()).toBe(calls);
    expect(repairDue(await mirror(a.id))).toBe(false);
  });

  it("the dedicated calendar deleted: one action required (calendar_deleted), no mirror touched, no further call", async () => {
    const { s, calendarId, a } = await reconciled();
    const generation = (await outboundRow(s)).generation;
    fake.deleteCalendar(calendarId);
    expect(await reconcile()).toMatchObject({ actionRequired: 1 });
    const row = await outboundRow(s);
    expect(row).toMatchObject({
      status: "action_required",
      action_code: "calendar_deleted",
      provider_calendar_id: null,
    });
    expect(row.generation).not.toBe(generation);
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "1" });
    const calls = providerCalls();
    await maintain();
    expect(providerCalls()).toBe(calls);
    sessionClient = s.owner.client;
    expect(ok(await getCalendarOutboundStatusAction())).toMatchObject({
      health: "action_required",
      actionRequired: "reactivate",
      reason: "calendar_deleted",
    });
  });
});

// ---------------------------------------------------------------------------

describe("authority and races", () => {
  const changes: [string, (s: Setup) => Promise<void>][] = [
    [
      "disabled",
      async (s) => {
        sessionClient = s.owner.client;
        ok(await disableCalendarOutboundAction());
      },
    ],
    [
      "reconnected (same account, new credentials)",
      async (s) => {
        await connect(s);
      },
    ],
    [
      "reconnected to another account",
      async (s) => {
        await connect(s, newAccount());
      },
    ],
    [
      "reactivated on a new calendar",
      async (s) => {
        const calendarId = (await outboundRow(s)).provider_calendar_id!;
        fake.deleteCalendar(calendarId);
        await db.query(
          `update private.calendar_outbound
           set status = 'action_required', action_code = 'calendar_deleted',
               generation = gen_random_uuid(), provider_calendar_id = null
           where business_id = $1`,
          [s.business.id],
        );
        sessionClient = s.owner.client;
        ok(await reactivateCalendarOutboundAction());
        background.length = 0;
        expect(
          await ensureOutboundCalendar(getCalendarDeps(), s.business.id),
        ).toBe("created");
      },
    ],
  ];

  it.each(changes)(
    "a listing in flight, then %s: its late page has no authority (no repair, no cursor)",
    async (_label, change) => {
      const { s, calendarId, a } = await reconciled();
      const token = (await recon(s))!.sync_token;
      fake.editEvent(calendarId, eventIdOf(a.id), { summary: "Autre" });
      const held = fake.hold(isListing);
      const pass = reconcile();
      await held.reached;
      await change(s);
      held.release();
      expect(await pass).toMatchObject({ reconciled: 0, drifted: 0 });
      expect(repairDue(await mirror(a.id))).toBe(false);
      expect((await recon(s))!.sync_token).toBe(token);
    },
  );

  it("stale snapshot: a page read before the write lands records at most one redundant repair, which settles", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await only(s);
    const a = await createAppointment(s, "10:00");
    await run(s);
    await reschedule(s, a.id, "17:00");
    // The listing answers with the event at 10:00; the write lands next.
    const held = fake.hold(isListing);
    const pass = reconcile();
    await held.reached;
    await run(s);
    held.release();
    // Indistinguishable from a manual edit made after the write: repaired.
    expect(await pass).toMatchObject({ reconciled: 1, drifted: 1 });
    expect(repairDue(await mirror(a.id))).toBe(true);
    expect(await mirror(a.id)).toMatchObject({
      desired_revision: "2",
      applied_revision: "2",
    });
    const patches = fake.count((_url, method) => method === "PATCH");
    await run(s);
    expect(fake.count((_url, method) => method === "PATCH")).toBe(patches + 1);
    expectCanonical(calendarId, a.id, "17:00");
    // Booking's own write comes back identical: nothing more, no loop.
    await due(s);
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    const writes = googleWrites();
    await run(s);
    expect(googleWrites()).toBe(writes);
    expect(repairDue(await mirror(a.id))).toBe(false);
  });

  it("BLOCKER: drift observed while the writer's answer is still pending is repaired after it completes, with an empty next listing", async () => {
    const { s, calendarId, a } = await reconciled();
    await reschedule(s, a.id, "17:00");
    // The writer's patch is applied at Google; its answer is held.
    const held = fake.hold((_url, method) => method === "PATCH");
    const worker = run(s);
    await held.reached;
    expect(instant(storedEvent(calendarId, a.id)!.start.dateTime)).toBe(
      at(D, "17:00"),
    );
    // The professional edits the event after that write.
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "B" });
    // Incremental listing: the mirror is still pending locally.
    expect(await mirror(a.id)).toMatchObject({
      desired_revision: "2",
      applied_revision: "1",
    });
    expect(await reconcile()).toMatchObject({ reconciled: 1, drifted: 1 });
    held.release();
    expect(await worker).toMatchObject({ applied: 1 });
    // The old success acknowledged its revision, not the newer drift.
    const row = (await mirror(a.id))!;
    expect(row).toMatchObject({ desired_revision: "2", applied_revision: "2" });
    expect(repairDue(row)).toBe(true);
    // Google has nothing new to say: the cursor consumed the edit.
    await due(s);
    const before = fake.requests.length;
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    const listed = fake.requests
      .slice(before)
      .filter((request) => isListing(request.url, request.method));
    expect(listed).toHaveLength(1);
    // Convergence without any new remote change.
    await run(s);
    expectCanonical(calendarId, a.id, "17:00");
    expect(repairDue(await mirror(a.id))).toBe(false);
  });

  it("BLOCKER: drift observed on a page requested before a write that completed meanwhile (applied_at >= page_started_at) is repaired", async () => {
    const { s, calendarId, a } = await reconciled();
    await reschedule(s, a.id, "17:00");
    // When the listing request reaches Google: the writer completes, then
    // the professional edits the event; the page shows that edit.
    let once = true;
    fake.hooks.push(async (url, method) => {
      if (!once || !isListing(url, method)) return;
      once = false;
      expect(await run(s)).toMatchObject({ applied: 1 });
      fake.editEvent(calendarId, eventIdOf(a.id), { summary: "B" });
    });
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    const { rows } = await db.query(
      `select m.applied_at >= r.page_started_at as after
       from private.appointment_calendar_mirrors m, private.calendar_outbound_reconciliation r
       where m.appointment_id = $1 and r.business_id = $2`,
      [a.id, s.business.id],
    );
    expect(rows[0].after).toBe(true);
    expect(repairDue(await mirror(a.id))).toBe(true);
    await due(s);
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    await run(s);
    expectCanonical(calendarId, a.id, "17:00");
  });

  it("R1 in flight, R2 observed meanwhile: the R1 success acknowledges R1 only, R2 is repaired next", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "B" });
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    const held = fake.hold((_url, method) => method === "PATCH");
    const worker = run(s);
    await held.reached;
    expectCanonical(calendarId, a.id);
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "C" });
    await due(s);
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    held.release();
    await worker;
    expect(await mirror(a.id)).toMatchObject({
      repair_generation: "2",
      repaired_generation: "1",
    });
    await run(s);
    expectCanonical(calendarId, a.id);
    expect(await mirror(a.id)).toMatchObject({ repaired_generation: "2" });
  });

  it("the cursor is never committed without the repairs it acknowledges: a failed page record keeps the change for the next pass", async () => {
    const { s, calendarId, a } = await reconciled();
    const token = (await recon(s))!.sync_token;
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "B" });
    const rpc = admin.rpc.bind(admin);
    const spy = vi.spyOn(admin, "rpc").mockImplementation(((
      name: string,
      ...rest: unknown[]
    ) =>
      name === "calendar_outbound_reconciliation_page"
        ? Promise.resolve({
            data: null,
            error: { message: "boom", code: "XX000", details: "", hint: "" },
          })
        : (rpc as (...args: unknown[]) => unknown)(name, ...rest)) as never);
    await expect(reconcile()).rejects.toBeDefined();
    spy.mockRestore();
    expect((await recon(s))!.sync_token).toBe(token);
    expect(repairDue(await mirror(a.id))).toBe(false);
    // Its lease expires; the same change is listed and recorded again.
    await db.query(
      "update private.calendar_outbound_reconciliation set lease_until = now() - interval '1 second' where business_id = $1",
      [s.business.id],
    );
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    await run(s);
    expectCanonical(calendarId, a.id);
  });

  it("the page record is one transaction: a failing repair statement leaves cursor and mirrors untouched", async () => {
    const { s, a } = await reconciled();
    const token = (await recon(s))!.sync_token;
    const { rows } = await db.query(
      "select public.calendar_outbound_claim_reconciliation('{}') as claim",
    );
    const claim = rows[0].claim as { claimId: string };
    const failed = await outcome(
      db.query(
        `select public.calendar_outbound_reconciliation_page($1, $2,
           jsonb_build_array(jsonb_build_object('appointment_id', $3::text), jsonb_build_object('appointment_id', 'not-a-uuid')),
           '{}', null, 'sync-new')`,
        [s.business.id, claim.claimId, a.id],
      ),
    );
    expect(failed).toMatch(/invalid input syntax for type uuid/);
    expect((await recon(s))!.sync_token).toBe(token);
    expect(await mirror(a.id)).toMatchObject({ repair_generation: "0" });
  });

  it("a manual edit between two pages of a full scan is seen by the next incremental listing and repaired", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await only(s);
    const a = await createAppointment(s, "09:00");
    await createAppointment(s, "11:00");
    await createAppointment(s, "13:00");
    await run(s);
    fake.pageSize = 1;
    // After page 1 (a), a is edited by hand.
    let once = true;
    fake.hooks.push((url, method) => {
      if (once && isListing(url, method) && pageOffsetOf(url) === 1) {
        once = false;
        fake.editEvent(calendarId, eventIdOf(a.id), { summary: "B" });
      }
    });
    expect(await reconcile()).toMatchObject({ reconciled: 1, drifted: 0 });
    await due(s);
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    await run(s);
    expectCanonical(calendarId, a.id, "09:00");
  });

  it("a local change while the repair is at Google: the repair is acknowledged, the newer revision stays due", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "Autre" });
    await reconcile();
    const held = fake.hold((url, method) => method === "PATCH");
    const worker = run(s);
    await held.reached;
    await reschedule(s, a.id, "17:00");
    held.release();
    await worker;
    const row = (await mirror(a.id))!;
    expect(row).toMatchObject({ desired_revision: "2", applied_revision: "1" });
    expect(repairDue(row)).toBe(false);
    await run(s);
    expectCanonical(calendarId, a.id, "17:00");
  });

  it("an older success never clears a newer drift", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "Autre" });
    await reconcile();
    const held = fake.hold((url, method) => method === "PATCH");
    const worker = run(s);
    await held.reached;
    // A newer drift recorded while the repair is at Google.
    await db.query(
      "update private.appointment_calendar_mirrors set repair_generation = repair_generation + 1 where appointment_id = $1",
      [a.id],
    );
    held.release();
    await worker;
    expect(await mirror(a.id)).toMatchObject({
      repair_generation: "2",
      repaired_generation: "1",
    });
    await run(s);
    expect(repairDue(await mirror(a.id))).toBe(false);
  });

  it("deleted in Google while cancelled in Booking during the listing: no repair, never resurrected", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.deleteEvent(calendarId, eventIdOf(a.id));
    const held = fake.hold(isListing);
    const pass = reconcile();
    await held.reached;
    await cancel(s, a.id);
    held.release();
    expect(await pass).toMatchObject({ drifted: 0 });
    expect(repairDue(await mirror(a.id))).toBe(false);
    await run(s);
    expect(storedEvent(calendarId, a.id)!.status).toBe("cancelled");
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "2" });
    await due(s);
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    expect(storedEvent(calendarId, a.id)!.status).toBe("cancelled");
  });

  it("edited in Google, then a new dedicated calendar: written once to the new one; the listing state starts over there", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { summary: "Autre" });
    await reconcile();
    expect(repairDue(await mirror(a.id))).toBe(true);
    await changes[3]![1](s);
    const second = (await outboundRow(s)).provider_calendar_id!;
    expect(second).not.toBe(calendarId);
    await run(s);
    expectCanonical(second, a.id);
    expect(repairDue(await mirror(a.id))).toBe(false);
    expect(await reconcile()).toMatchObject({ reconciled: 1, drifted: 0 });
    expect(await recon(s)).toMatchObject({ provider_calendar_id: second });
  });

  it("one claim at a time per business; a released claim has no authority", async () => {
    const { s } = await reconciled();
    const claimed = await db.query(
      "select public.calendar_outbound_claim_reconciliation('{}') as claim",
    );
    const claim = claimed.rows[0].claim as { claimId: string };
    expect(claim).not.toBeNull();
    const second = await db.query(
      "select public.calendar_outbound_claim_reconciliation('{}') as claim",
    );
    expect(second.rows[0].claim).toBeNull();
    await db.query(
      "select public.calendar_outbound_reconciliation_release($1, $2)",
      [s.business.id, claim.claimId],
    );
    const { rows } = await db.query(
      "select public.calendar_outbound_reconciliation_page($1, $2, '[]', '{}', null, 'sync-x') as page",
      [s.business.id, claim.claimId],
    );
    expect(rows[0].page).toMatchObject({ result: "superseded" });
  });

  it("a page being recorded holds the authority: a disable waits for it", async () => {
    const { s } = await reconciled();
    const { rows } = await db.query(
      "select public.calendar_outbound_claim_reconciliation('{}') as claim",
    );
    const claim = rows[0].claim as { claimId: string };
    const recording = await openTransaction();
    await recording.connection.query(
      "select public.calendar_outbound_reconciliation_page($1, $2, '[]', '{}', 'p1', null)",
      [s.business.id, claim.claimId],
    );
    const disabling = await openTransaction({
      role: "authenticated",
      userId: s.owner.userId,
    });
    const disabled = outcome(
      disabling.connection.query(
        "select public.calendar_outbound_disable($1)",
        [s.business.id],
      ),
    );
    await waitUntilBlocked(disabling.pid);
    expect(await blockingPids(disabling.pid)).toContain(recording.pid);
    await closeTransaction(recording, "commit");
    expect(await disabled).toBe("ok");
    await closeTransaction(disabling, "commit");
    const { rows: late } = await db.query(
      "select public.calendar_outbound_reconciliation_page($1, $2, '[]', '{}', null, 'sync-y') as page",
      [s.business.id, claim.claimId],
    );
    expect(late[0].page).toMatchObject({ result: "superseded" });
  });
});

// ---------------------------------------------------------------------------

describe("isolation and scheduling", () => {
  it("two businesses of the same Google account: each calendar reconciles its own mirrors only", async () => {
    const account = newAccount();
    const one = await setup(account);
    const calendarOne = await enabled(one);
    const two = await setup(account);
    const calendarTwo = await enabled(two);
    expect(calendarTwo).not.toBe(calendarOne);
    await only(one, two);
    const a = await createAppointment(one, "10:00");
    const b = await createAppointment(two, "10:00");
    await run(one);
    await run(two);
    expect(await reconcile()).toMatchObject({ reconciled: 2, drifted: 0 });
    await due(one);
    await due(two);

    // b's event copied into one's calendar, edited there: not one's.
    fake.putEvent(calendarOne, {
      ...storedEvent(calendarTwo, b.id)!,
      summary: "Copie",
    });
    fake.editEvent(calendarTwo, eventIdOf(b.id), { summary: "Autre" });
    expect(await reconcile()).toMatchObject({ reconciled: 2, drifted: 1 });
    expect(repairDue(await mirror(a.id))).toBe(false);
    expect(repairDue(await mirror(b.id))).toBe(true);
    await run(two);
    expect(storedEvent(calendarTwo, b.id)!.summary).toBe("Léa — Coupe");
    expect(storedEvent(calendarOne, b.id)!.summary).toBe("Copie");
  });

  it("a kick after a change never lists nor backfills", async () => {
    const s = await setup();
    await connect(s);
    const before = await createAppointment(s, "10:00");
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);
    await createAppointment(s, "12:00");
    await run(s);
    expect(listings()).toBe(0);
    expect(await mirror(before.id)).toBeUndefined();
  });

  it("the periodic job: writes first, reconciliation keeps its share even when writes hang", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await only(s);
    await createAppointment(s, "10:00");
    await run(s);
    await createAppointment(s, "12:00");
    // The insert never answers (nor its retries): writes stop at their
    // share, and reconciliation still runs.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      fake.hold(
        (url, method) => method === "POST" && /\/events$/.test(url.pathname),
      );
    }
    const result = await maintain(24_000);
    expect(result).toMatchObject({ applied: 0, retried: 1, reconciled: 1 });
    expect((await recon(s))!.provider_calendar_id).toBe(calendarId);
  }, 45_000);

  it("a writer claim stuck on a database lock (statement timeout) never takes reconciliation's turn; the write is applied by the next run", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await only(s);
    const a = await createAppointment(s, "10:00");
    await run(s);
    // b is due (never written): only the writer claims it. Its mirror is
    // locked, so the claim waits in PostgreSQL until the role's statement
    // timeout cancels it.
    const b = await createAppointment(s, "14:00");
    const locker = await openTransaction();
    await locker.connection.query(
      "select 1 from private.appointment_calendar_mirrors where appointment_id = $1 for update",
      [b.id],
    );
    const started = Date.now();
    const result = await maintain(24_000);
    expect(result).toMatchObject({ applied: 0, reconciled: 1 });
    expect(Date.now() - started).toBeLessThan(24_000);
    expect((await recon(s))!.sync_token).toEqual(expect.any(String));
    await closeTransaction(locker, "commit");

    // The cancelled claim left nothing behind: the next run writes.
    expect(await mirror(b.id)).toMatchObject({ applied_revision: "0" });
    expect(await run(s)).toMatchObject({ applied: 1 });
    expectCanonical(calendarId, a.id, "10:00");
    expect(storedEvent(calendarId, b.id)!.status).toBe("confirmed");
  }, 60_000);

  it("the periodic job end to end: backfill, writes, reconciliation and repair in one run", async () => {
    const s = await setup();
    await connect(s);
    const a = await createAppointment(s, "10:00");
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    await only(s);
    const result = await runCalendarJob(getCalendarDeps(), {
      budgetMs: 40_000,
    });
    expect(result.outbound).toMatchObject({
      backfilled: 1,
      applied: 1,
      reconciled: 1,
      drifted: 0,
    });
    const calendarId = (await outboundRow(s)).provider_calendar_id!;
    expectCanonical(calendarId, a.id);
  }, 60_000);

  it("server only: no professional may call the workers' functions; the status never carries a cursor", async () => {
    const { s } = await reconciled();
    for (const call of [
      "select public.calendar_outbound_backfill(5, 100)",
      "select public.calendar_outbound_claim_reconciliation('{}')",
      `select public.calendar_outbound_reconciliation_snapshot('${s.business.id}', gen_random_uuid(), '{}')`,
      `select public.calendar_outbound_reconciliation_page('${s.business.id}', gen_random_uuid(), '[]', '{}', null, 'x')`,
      `select public.calendar_outbound_reconciliation_release('${s.business.id}', gen_random_uuid())`,
      `select public.calendar_outbound_reconciliation_failed('${s.business.id}', gen_random_uuid(), 'retry')`,
      `select public.calendar_outbound_release_mirror(gen_random_uuid(), gen_random_uuid())`,
      `select public.calendar_outbound_complete_mirror(gen_random_uuid(), gen_random_uuid(), 1, 1)`,
    ]) {
      for (const role of ["authenticated", "anon"] as const) {
        const transaction = await openTransaction({
          role,
          userId: role === "authenticated" ? s.owner.userId : undefined,
        });
        const result = await outcome(transaction.connection.query(call));
        await closeTransaction(transaction, "rollback");
        expect(result).toMatch(/permission denied/);
      }
    }
    const { rows } = await db.query(
      "select has_table_privilege('authenticated', 'private.calendar_outbound_reconciliation', 'select') as readable",
    );
    expect(rows[0].readable).toBe(false);
    sessionClient = s.owner.client;
    const status = ok(await getCalendarOutboundStatusAction());
    expect(JSON.stringify(status)).not.toMatch(/sync-|syncToken|pageToken/);
  });
});

// ---------------------------------------------------------------------------

describe("fields Booking does not own are preserved", () => {
  const patches = () => fake.count((_url, method) => method === "PATCH");
  const puts = () => fake.count((_url, method) => method === "PUT");
  const reminders = {
    useDefault: false,
    overrides: [{ method: "popup", minutes: 30 }],
  };

  it("A. description: the appointment moves, only the managed fields are written (one partial update, no read)", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { description: "Code 1234" });
    const reads = fake.count(
      (url, method) =>
        method === "GET" && url.pathname.includes(`/events/${eventIdOf(a.id)}`),
    );
    const [patchesBefore, putsBefore] = [patches(), puts()];
    await reschedule(s, a.id, "17:00");
    await run(s);
    expectCanonical(calendarId, a.id, "17:00");
    expect(storedEvent(calendarId, a.id)).toMatchObject({
      description: "Code 1234",
    });
    expect(patches() - patchesBefore).toBe(1);
    expect(puts()).toBe(putsBefore);
    expect(
      fake.count(
        (url, method) =>
          method === "GET" &&
          url.pathname.includes(`/events/${eventIdOf(a.id)}`),
      ),
    ).toBe(reads);
    const patch = fake.requests.filter((r) => r.method === "PATCH").at(-1)!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("none");
    expect(Object.keys(JSON.parse(patch.body)).sort()).toEqual([
      "end",
      "extendedProperties",
      "start",
      "status",
      "summary",
      "transparency",
    ]);
  });

  it("B. colour: the title changes (client renamed), the colour stays", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { colorId: "5" });
    await db.query(
      `update public.clients set first_name = 'Zoé'
       where id = (select client_id from public.appointments where id = $1)`,
      [a.id],
    );
    await run(s);
    expect(storedEvent(calendarId, a.id)).toMatchObject({
      summary: "Zoé — Coupe",
      colorId: "5",
      status: "confirmed",
    });
  });

  it("C. reminders: a repair of the title keeps the professional's reminders", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), {
      summary: "Autre",
      reminders,
    });
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    await run(s);
    expectCanonical(calendarId, a.id);
    expect(storedEvent(calendarId, a.id)).toMatchObject({ reminders });
  });

  it("D. moved by hand and described: the time is repaired, the description kept; other private keys too", async () => {
    const { s, calendarId, a } = await reconciled();
    const own = storedEvent(calendarId, a.id)!.extendedProperties!.private!;
    fake.editEvent(calendarId, eventIdOf(a.id), {
      start: { dateTime: at(D, "12:00"), timeZone: "Europe/Paris" },
      end: { dateTime: at(D, "13:00") },
      description: "Déplacé",
      extendedProperties: { private: { ...own, other: "kept" } },
    });
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    await run(s);
    expectCanonical(calendarId, a.id);
    expect(storedEvent(calendarId, a.id)).toMatchObject({
      description: "Déplacé",
      end: { dateTime: expect.any(String) },
      extendedProperties: { private: { other: "kept" } },
    });
    expect(instant(storedEvent(calendarId, a.id)!.end.dateTime)).toBe(
      at(D, "11:00"),
    );
  });

  it("D'. turned all-day by hand: the repair removes the date and writes the instants", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), {
      start: { date: D },
      end: { date: D },
      description: "Journée",
    });
    expect(await reconcile()).toMatchObject({ drifted: 1 });
    await run(s);
    expectCanonical(calendarId, a.id);
    expect(storedEvent(calendarId, a.id)!.end.date).toBeUndefined();
    expect(storedEvent(calendarId, a.id)!.description).toBe("Journée");
  });

  it("E. only unmanaged fields changed: no drift, no repair, no write", async () => {
    const { calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), {
      description: "Note",
      location: "Salon 2",
      colorId: "7",
      reminders,
    });
    const writes = googleWrites();
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    expect(repairDue(await mirror(a.id))).toBe(false);
    expect(googleWrites()).toBe(writes);
  });

  it.each(["keeps_cancelled", "gone", "restores"] as const)(
    "F. deleted in Google, appointment active (patch on a deleted event: %s): restored, never duplicated",
    async (mode) => {
      const { s, calendarId, a } = await reconciled();
      fake.patchOnCancelled = mode;
      fake.deleteEvent(calendarId, eventIdOf(a.id));
      expect(await reconcile()).toMatchObject({ drifted: 1 });
      const putsBefore = puts();
      await run(s);
      expectCanonical(calendarId, a.id);
      expect(fake.storedEvents(calendarId)).toHaveLength(1);
      // The dedicated restoration only when the partial update did not.
      expect(puts() - putsBefore).toBe(mode === "restores" ? 0 : 1);
      await due(s);
      expect(await reconcile()).toMatchObject({ drifted: 0 });
    },
  );

  it.each(["keeps_cancelled", "gone", "restores"] as const)(
    "F'. deleted in Google, then moved in Booking before any listing (%s): restored at the new time",
    async (mode) => {
      const { s, calendarId, a } = await reconciled();
      fake.patchOnCancelled = mode;
      fake.deleteEvent(calendarId, eventIdOf(a.id));
      await reschedule(s, a.id, "17:00");
      await run(s);
      expectCanonical(calendarId, a.id, "17:00");
      expect(fake.storedEvents(calendarId)).toHaveLength(1);
    },
  );

  it("G. deleted with its manual fields: the restoration recreates the canonical event (manual fields not promised)", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { description: "Perdue" });
    fake.deleteEvent(calendarId, eventIdOf(a.id));
    await reconcile();
    await run(s);
    expectCanonical(calendarId, a.id);
  });

  it("purged in Google (no such id any more), then moved in Booking: inserted again with the same id", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.purgeEvent(calendarId, eventIdOf(a.id));
    await reschedule(s, a.id, "17:00");
    await run(s);
    expectCanonical(calendarId, a.id, "17:00");
    expect(fake.storedEvents(calendarId)).toHaveLength(1);
  });

  it("H. partial update whose answers are lost: retried, converges, manual fields kept", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { description: "Garde" });
    await reschedule(s, a.id, "17:00");
    fake.loseAnswer((_url, method) => method === "PATCH", 4);
    expect(await run(s)).toMatchObject({ applied: 0, retried: 1 });
    await db.query(
      "update private.appointment_calendar_mirrors set next_attempt_at = now() where appointment_id = $1",
      [a.id],
    );
    expect(await run(s)).toMatchObject({ applied: 1 });
    expectCanonical(calendarId, a.id, "17:00");
    expect(storedEvent(calendarId, a.id)!.description).toBe("Garde");
    expect(fake.storedEvents(calendarId)).toHaveLength(1);
  });

  it("I. cancelled in Booking: removed in Google, never restored nor patched", async () => {
    const { s, calendarId, a } = await reconciled();
    fake.editEvent(calendarId, eventIdOf(a.id), { description: "x" });
    const [patchesBefore, putsBefore] = [patches(), puts()];
    await cancel(s, a.id);
    await run(s);
    expect(storedEvent(calendarId, a.id)!.status).toBe("cancelled");
    await due(s);
    expect(await reconcile()).toMatchObject({ drifted: 0 });
    await run(s);
    expect(storedEvent(calendarId, a.id)!.status).toBe("cancelled");
    expect(patches()).toBe(patchesBefore);
    expect(puts()).toBe(putsBefore);
  });
});
