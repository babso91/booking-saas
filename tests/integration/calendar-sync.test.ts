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
import { GET as cronGet } from "@/app/api/cron/calendar/route";
import { POST as webhook } from "@/app/api/calendar/google/webhook/route";
import {
  disconnectGoogleCalendarAction,
  getCalendarIntegrationStatusAction,
  listCalendarConflictsAction,
  listConnectedCalendarsAction,
  startGoogleCalendarConnectAction,
  syncGoogleCalendarNowAction,
  updateBlockingCalendarsAction,
} from "@/features/calendar/actions/calendar";
import { createManualAppointment } from "@/features/agenda/data/appointments";
import type { ActionResult } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import { FakeGoogle, type FakeEvent } from "../support/fake-google";
import {
  anonClient,
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
import { openTransaction, waitUntilBlocked } from "./support/transactions";

// Google Calendar inbound sync against the real stack. Google itself is the
// in-memory FakeGoogle (tests/support/fake-google.ts), reached through the
// real adapter over a stubbed `fetch`; everything else is real: Server
// Actions, route handlers, SQL functions, RLS, availability and booking.

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
const WEBHOOK_URL = "https://hooks.example.test/api/calendar/google/webhook";

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY =
    randomBytes(32).toString("base64");
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = WEBHOOK_URL;
  process.env.CRON_SECRET = "c".repeat(40);
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

function failed<T>(result: ActionResult<T>) {
  if (result.ok) throw new Error("Expected a failure");
  return result.error.code;
}

const D = dateInDays(10);
const D2 = dateInDays(11);
const at = (date: string, time: string) => `${date}T${time}:00Z`;

type Setup = {
  owner: Professional;
  business: TestBusiness;
  service: string;
  account: { sub: string; email: string };
};

async function setup(
  options: { buffer?: number; timezone?: string } = {},
): Promise<Setup> {
  const owner = await createProfessional("calendar");
  const business = await createBusiness(owner.userId, {
    timezone: options.timezone ?? "UTC",
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: options.buffer ?? 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
    },
  });
  await setWeeklyHours(business.id, everyDay(["09:00", "19:00"]));
  const service = await createService(business.id, { durationMinutes: 60 });
  const account = {
    sub: `sub-${randomUUID()}`,
    email: `${randomUUID().slice(0, 6)}@gmail.test`,
  };
  fake.setCalendars(account.sub, [
    { id: account.email, summary: "Personnel", timeZone: "UTC", primary: true },
    { id: `work-${account.sub}`, summary: "Travail", timeZone: "UTC" },
    {
      id: `birthdays-${account.sub}`,
      summary: "Anniversaires",
      timeZone: "UTC",
      accessRole: "reader",
    },
  ]);
  return { owner, business, service, account };
}

function callbackRequest(query: Record<string, string>) {
  const url = new URL("http://localhost:3000/api/calendar/google/callback");
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  return new NextRequest(url);
}

const resultOf = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get("calendar");

async function beginConnect(s: Setup, account = s.account) {
  sessionClient = s.owner.client;
  const { authorizationUrl } = ok(await startGoogleCalendarConnectAction());
  return fake.authorize(account, authorizationUrl);
}

async function connect(s: Setup, account = s.account) {
  const { code, state } = await beginConnect(s, account);
  const response = await oauthCallback(callbackRequest({ state, code }));
  expect(resultOf(response)).toBe("connected");
  await flush();
}

async function calendarsOf(s: Setup) {
  sessionClient = s.owner.client;
  return ok(await listConnectedCalendarsAction());
}

async function select(s: Setup, names: string[]) {
  const calendars = await calendarsOf(s);
  const ids = calendars
    .filter((calendar) => names.includes(calendar.name))
    .map((c) => c.id);
  ok(await updateBlockingCalendarsAction({ calendarIds: ids }));
  await flush();
  return ids;
}

const work = (s: Setup) => `work-${s.account.sub}`;
const personal = (s: Setup) => s.account.email;

function timed(
  id: string,
  date: string,
  from: string,
  to: string,
  extra: Partial<FakeEvent> = {},
): FakeEvent {
  return {
    id,
    start: { dateTime: at(date, from) },
    end: { dateTime: at(date, to) },
    ...extra,
  };
}

async function storedEvents(s: Setup) {
  const { rows } = await db.query<{
    provider_event_id: string;
    starts_at: Date;
    ends_at: Date;
    busy: boolean;
    all_day: boolean;
  }>(
    `select provider_event_id, starts_at, ends_at, busy, all_day
     from public.external_calendar_events where business_id = $1
     order by starts_at, provider_event_id`,
    [s.business.id],
  );
  return rows;
}

async function slots(s: Setup, date = D) {
  const { rows } = await db.query<{ starts_at: Date }>(
    `select starts_at from private.available_slots($1, $2, $3::date, now())`,
    [s.business.id, s.service, date],
  );
  return rows.map((row) => row.starts_at.toISOString());
}

async function book(s: Setup, startsAt: string) {
  const { rows } = await db.query<{ starts_at: Date }>(
    `select starts_at from private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Cliente', $4)`,
    [s.business.slug, s.service, startsAt, `${randomUUID()}@x.test`],
  );
  return rows[0]!.starts_at.toISOString();
}

async function syncNow(s: Setup) {
  sessionClient = s.owner.client;
  return ok(await syncGoogleCalendarNowAction());
}

function notification(headers: Record<string, string>) {
  return new Request(WEBHOOK_URL, { method: "POST", headers });
}

async function currentChannel(calendarId: string) {
  const { rows } = await db.query<{
    channel_id: string;
    channel_resource_id: string;
    channel_expires_at: Date;
  }>(
    "select channel_id, channel_resource_id, channel_expires_at from private.external_calendar_sync where calendar_id = $1",
    [calendarId],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------

describe("OAuth connection", () => {
  it("connects: account, calendars (all pages), encrypted credentials only", async () => {
    fake.pageSize = 2;
    const s = await setup();
    await connect(s);

    const status = ok(await getCalendarIntegrationStatusAction());
    expect(status).toMatchObject({
      provider: "google",
      available: true,
      connection: { status: "active", accountEmail: s.account.email },
    });
    expect(
      status.calendars.map((calendar) => [
        calendar.name,
        calendar.primary,
        calendar.blocking,
      ]),
    ).toEqual([
      ["Personnel", true, false],
      ["Anniversaires", false, false],
      ["Travail", false, false],
    ]);

    const { rows } = await db.query(
      `select s.refresh_token_ciphertext, s.access_token_ciphertext
       from private.calendar_secrets s join public.calendar_connections c on c.id = s.connection_id
       where c.business_id = $1`,
      [s.business.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].refresh_token_ciphertext).toMatch(/^v1\./);
    expect(JSON.stringify(rows[0])).not.toMatch(/rt-|at-/);
    // No state left behind.
    const states = await db.query(
      "select 1 from private.calendar_oauth_states where business_id = $1",
      [s.business.id],
    );
    expect(states.rowCount).toBe(0);
  });

  it("denied consent: nothing stored, the state cannot be replayed", async () => {
    const s = await setup();
    const { state, code } = await beginConnect(s);
    expect(
      resultOf(
        await oauthCallback(callbackRequest({ state, error: "access_denied" })),
      ),
    ).toBe("denied");
    expect(
      resultOf(await oauthCallback(callbackRequest({ state, code }))),
    ).toBe("invalid_state");
    expect(
      ok(await getCalendarIntegrationStatusAction()).connection,
    ).toBeNull();
  });

  it("refuses a missing, unknown, expired or replayed state", async () => {
    const s = await setup();
    const { state, code } = await beginConnect(s);
    sessionClient = s.owner.client;
    expect(resultOf(await oauthCallback(callbackRequest({ code })))).toBe(
      "invalid_state",
    );
    expect(
      resultOf(await oauthCallback(callbackRequest({ state: "forged", code }))),
    ).toBe("invalid_state");

    expect(
      resultOf(await oauthCallback(callbackRequest({ state, code }))),
    ).toBe("connected");
    expect(
      resultOf(await oauthCallback(callbackRequest({ state, code }))),
    ).toBe("invalid_state");

    const second = await beginConnect(s);
    await db.query(
      "update private.calendar_oauth_states set expires_at = now() - interval '1 second' where business_id = $1",
      [s.business.id],
    );
    expect(resultOf(await oauthCallback(callbackRequest(second)))).toBe(
      "invalid_state",
    );

    const { rows } = await db.query(
      "select count(*)::int as n from public.calendar_connections where business_id = $1",
      [s.business.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses a state used by another signed-in user, or after losing membership", async () => {
    const a = await setup();
    const b = await setup();
    const { state, code } = await beginConnect(a);

    sessionClient = b.owner.client;
    expect(
      resultOf(await oauthCallback(callbackRequest({ state, code }))),
    ).toBe("invalid_state");

    sessionClient = anonClient();
    expect(
      resultOf(await oauthCallback(callbackRequest({ state, code }))),
    ).toBe("invalid_state");

    // A's state is still unused, but A is no longer a member of the business.
    await db.query("delete from public.business_members where user_id = $1", [
      a.owner.userId,
    ]);
    sessionClient = a.owner.client;
    await oauthCallback(callbackRequest({ state, code }));
    const { rows } = await db.query(
      "select count(*)::int as n from public.calendar_connections where business_id = $1",
      [a.business.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("stores nothing when the code exchange fails or a scope was not granted", async () => {
    const s = await setup();
    const first = await beginConnect(s);
    fake.failNext((url) => url.pathname === "/token", 400, 1, {
      error: "invalid_grant",
    });
    expect(resultOf(await oauthCallback(callbackRequest(first)))).toBe(
      "provider_unavailable",
    );

    fake.grantedScopes = fake.grantedScopes.filter(
      (scope) => !scope.endsWith("events.readonly"),
    );
    const second = await beginConnect(s);
    expect(resultOf(await oauthCallback(callbackRequest(second)))).toBe(
      "scope_missing",
    );

    expect(
      ok(await getCalendarIntegrationStatusAction()).connection,
    ).toBeNull();
  });

  it("reconnects the same account in place (two tabs too): one connection, rotated tokens, selection kept", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const before = await db.query(
      "select s.refresh_token_ciphertext from private.calendar_secrets s join public.calendar_connections c on c.id = s.connection_id where c.business_id = $1",
      [s.business.id],
    );

    const tabA = await beginConnect(s);
    const tabB = await beginConnect(s);
    expect(resultOf(await oauthCallback(callbackRequest(tabA)))).toBe(
      "connected",
    );
    expect(resultOf(await oauthCallback(callbackRequest(tabB)))).toBe(
      "connected",
    );
    await flush();

    const { rows } = await db.query(
      `select c.id, c.status, s.refresh_token_ciphertext from public.calendar_connections c
       join private.calendar_secrets s on s.connection_id = c.id where c.business_id = $1`,
      [s.business.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].refresh_token_ciphertext).not.toBe(
      before.rows[0].refresh_token_ciphertext,
    );
    expect(
      (await calendarsOf(s))
        .filter((calendar) => calendar.blocking)
        .map((c) => c.name),
    ).toEqual(["Travail"]);
  });

  it("keeps the stored refresh token when Google sends none for the same account", async () => {
    const s = await setup();
    await connect(s);
    fake.sendRefreshToken = false;
    await connect(s);
    fake.putEvent(work(s), timed("e1", D, "14:00", "15:00"));
    await select(s, ["Travail"]);
    fake.expireAccessTokens();
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
  });

  it("another account replaces the previous one entirely", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("e1", D, "14:00", "15:00"));
    await select(s, ["Travail"]);
    expect(await storedEvents(s)).toHaveLength(1);

    const other = { sub: `sub-${randomUUID()}`, email: "other@gmail.test" };
    fake.setCalendars(other.sub, [
      {
        id: "other@gmail.test",
        summary: "Autre",
        timeZone: "UTC",
        primary: true,
      },
    ]);
    await connect(s, other);
    expect(await storedEvents(s)).toHaveLength(0);
    expect((await calendarsOf(s)).map((calendar) => calendar.name)).toEqual([
      "Autre",
    ]);
  });
});

describe("blocking selection and sync", () => {
  it("initial sync of selected calendars across pages; deselection stops blocking at once", async () => {
    fake.pageSize = 2;
    const s = await setup();
    await connect(s);
    for (let i = 0; i < 5; i += 1) {
      fake.putEvent(work(s), timed(`w${i}`, D, `${10 + i}:00`, `${10 + i}:30`));
    }
    fake.putEvent(personal(s), timed("p1", D2, "09:00", "10:00"));
    fake.putEvent(`birthdays-${s.account.sub}`, {
      id: "b1",
      start: { date: D },
      end: { date: D2 },
      eventType: "birthday",
    });

    await select(s, ["Travail", "Personnel"]);
    expect((await storedEvents(s)).map((row) => row.provider_event_id)).toEqual(
      ["w0", "w1", "w2", "w3", "w4", "p1"],
    );
    expect(await slots(s)).not.toContain(
      at(D, "10:00").replace(":00Z", ":00.000Z"),
    );
    const workId = (await calendarsOf(s)).find(
      (calendar) => calendar.name === "Travail",
    )!.id;
    const channel = await currentChannel(workId);
    expect(channel?.channel_id).toBeTruthy();

    await select(s, ["Personnel"]);
    expect((await storedEvents(s)).map((row) => row.provider_event_id)).toEqual(
      ["p1"],
    );
    expect(await slots(s)).toContain(`${D}T10:00:00.000Z`);
    expect(fake.channels.get(channel!.channel_id)?.stopped).toBe(true);
  });

  it("only busy events block: transparent, cancelled, declined and working location do not", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("busy", D, "09:00", "10:00"));
    fake.putEvent(
      work(s),
      timed("free", D, "11:00", "12:00", { transparency: "transparent" }),
    );
    fake.putEvent(
      work(s),
      timed("declined", D, "13:00", "14:00", {
        attendees: [{ self: true, responseStatus: "declined" }],
      }),
    );
    fake.putEvent(
      work(s),
      timed("location", D, "15:00", "16:00", { eventType: "workingLocation" }),
    );
    fake.putEvent(work(s), timed("gone", D, "17:00", "18:00"));
    fake.deleteEvent(work(s), "gone");
    await select(s, ["Travail"]);

    expect(
      (await storedEvents(s)).map((row) => [row.provider_event_id, row.busy]),
    ).toEqual([
      ["busy", true],
      ["free", false],
      ["declined", false],
      ["location", false],
    ]);
    const free = await slots(s);
    expect(free).not.toContain(`${D}T09:00:00.000Z`);
    for (const time of ["11:00", "13:00", "15:00", "17:00"]) {
      expect(free).toContain(`${D}T${time}:00.000Z`);
    }
  });

  it("incremental sync: moved, deleted and new events; the cursor advances", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    fake.putEvent(work(s), timed("b", D, "11:00", "12:00"));
    await select(s, ["Travail"]);
    const listsBefore = fake.requests.length;

    fake.putEvent(work(s), timed("a", D, "16:00", "17:00"));
    fake.deleteEvent(work(s), "b");
    fake.putEvent(work(s), timed("c", D2, "09:00", "10:00"));
    await syncNow(s);

    expect(
      (await storedEvents(s)).map((row) => [
        row.provider_event_id,
        row.starts_at.toISOString(),
      ]),
    ).toEqual([
      ["a", `${D}T16:00:00.000Z`],
      ["c", `${D2}T09:00:00.000Z`],
    ]);
    const incremental = fake.requests
      .slice(listsBefore)
      .filter((request) => request.url.pathname.endsWith("/events"));
    expect(
      incremental.map((request) => [
        request.url.searchParams.has("syncToken"),
        request.url.searchParams.has("timeMin"),
      ]),
    ).toEqual([[true, false]]);
    expect(await slots(s)).toContain(`${D}T09:00:00.000Z`);
    expect(await slots(s)).not.toContain(`${D}T16:00:00.000Z`);
  });

  it("410 Gone: full resync replaces the local copy, without duplicates", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    fake.putEvent(work(s), timed("b", D, "11:00", "12:00"));
    await select(s, ["Travail"]);

    fake.expireSyncTokens();
    fake.putEvent(work(s), timed("c", D, "13:00", "14:00"));
    // Deleted while the token was expired: only the sweep can remove it.
    fake.deleteEvent(work(s), "b");
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
    expect((await storedEvents(s)).map((row) => row.provider_event_id)).toEqual(
      ["a", "c"],
    );
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
  });

  it("recurring series: instances stored, one moved, the series deleted", async () => {
    const s = await setup();
    await connect(s);
    for (const [i, date] of [D, D2, dateInDays(12)].entries()) {
      fake.putEvent(
        work(s),
        timed(`series_${i}`, date, "12:00", "13:00", {
          recurringEventId: "series",
        }),
      );
    }
    await select(s, ["Travail"]);
    expect(await storedEvents(s)).toHaveLength(3);

    fake.putEvent(
      work(s),
      timed("series_1", D2, "15:00", "16:00", { recurringEventId: "series" }),
    );
    await syncNow(s);
    expect(
      (await storedEvents(s)).map((row) => row.starts_at.toISOString()),
    ).toContain(`${D2}T15:00:00.000Z`);

    // Whole series deleted (Google may report the series id itself).
    fake.putEvent(work(s), {
      id: "series",
      status: "cancelled",
      start: { dateTime: at(D, "12:00") },
      end: { dateTime: at(D, "13:00") },
    });
    await syncNow(s);
    expect(await storedEvents(s)).toHaveLength(0);
  });

  it("an interrupted full sync (page 2 of 5) resumes, with nothing duplicated or lost", async () => {
    fake.pageSize = 2;
    const s = await setup();
    await connect(s);
    for (let i = 0; i < 9; i += 1)
      fake.putEvent(
        work(s),
        timed(`e${i}`, dateInDays(10 + i), "10:00", "11:00"),
      );

    // Page 2 fails every retry: the first page is applied, its cursor saved.
    fake.failNext(
      (url) =>
        url.pathname.endsWith("/events") &&
        url.searchParams.get("pageToken") === "2",
      503,
      4,
    );
    await select(s, ["Travail"]);
    expect(await storedEvents(s)).toHaveLength(2);
    const [calendar] = (await calendarsOf(s)).filter((item) => item.blocking);
    expect(calendar!.syncStatus).toBe("error");

    const outcome = await syncNow(s);
    expect(Object.values(outcome.outcomes)).toEqual(["synced"]);
    expect((await storedEvents(s)).map((row) => row.provider_event_id)).toEqual(
      ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"],
    );
    // Resumed at page 2, not restarted.
    const resumed = fake.requests
      .filter((request) => request.url.pathname.endsWith("/events"))
      .slice(-4);
    expect(resumed[0]!.url.searchParams.get("pageToken")).toBe("2");
    expect(
      (await calendarsOf(s)).find((item) => item.blocking)!.syncStatus,
    ).toBe("idle");
  });

  it("a calendar too large for the bounded sync is reported, never synced without limit", async () => {
    fake.pageSize = 2;
    const s = await setup();
    await connect(s);
    for (let i = 0; i < 85; i += 1)
      fake.putEvent(work(s), timed(`e${i}`, D, "10:00", "10:30"));
    await select(s, ["Travail"]);
    const calendar = (await calendarsOf(s)).find((item) => item.blocking)!;
    expect(calendar).toMatchObject({
      syncStatus: "error",
      lastError: "too_many_events",
    });
    // 40 pages at most were read; what was read keeps blocking.
    expect(fake.count((url) => url.pathname.endsWith("/events"))).toBe(40);
    expect(await storedEvents(s)).toHaveLength(80);
  });

  it("429 is retried; an expired access token is refreshed once", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    fake.failNext((url) => url.pathname.endsWith("/events"), 429, 2);
    await select(s, ["Travail"]);
    expect(await storedEvents(s)).toHaveLength(1);

    fake.expireAccessTokens();
    fake.putEvent(work(s), timed("b", D, "11:00", "12:00"));
    await syncNow(s);
    expect(await storedEvents(s)).toHaveLength(2);
    expect(
      fake.count(
        (url, method) => url.pathname === "/token" && method === "POST",
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it("revoked access: the connection needs reconnecting, busy periods keep blocking", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);

    fake.revokeAll();
    fake.putEvent(work(s), timed("b", D, "11:00", "12:00"));
    // The sync meets invalid_grant: recorded, never thrown at the user.
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["error"]);
    sessionClient = s.owner.client;
    expect(failed(await syncGoogleCalendarNowAction())).toBe(
      "calendar_reauth_required",
    );
    const status = ok(await getCalendarIntegrationStatusAction());
    expect(status.connection?.status).toBe("reauth_required");
    expect(await slots(s)).not.toContain(`${D}T09:00:00.000Z`);
    expect(JSON.stringify(status)).not.toMatch(/rt-|at-/);
  });

  it("50 identical notifications: one sync at a time, same final state", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const calendarId = (await calendarsOf(s)).find((item) => item.blocking)!.id;
    const channel = await currentChannel(calendarId);
    const token = fake.channels.get(channel!.channel_id)!.token;

    fake.putEvent(work(s), timed("b", D, "11:00", "12:00"));
    const before = fake.count((url) => url.pathname.endsWith("/events"));
    const headers = {
      "x-goog-channel-id": channel!.channel_id,
      "x-goog-resource-id": channel!.channel_resource_id,
      "x-goog-channel-token": token,
      "x-goog-resource-state": "exists",
      "x-goog-message-number": "2",
    };
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => webhook(notification(headers))),
    );
    expect(responses.every((response) => response.status === 204)).toBe(true);
    expect(background).toHaveLength(50);
    await flush();

    expect((await storedEvents(s)).map((row) => row.provider_event_id)).toEqual(
      ["a", "b"],
    );
    // Concurrent notifications coalesce into a few passes, not 50.
    expect(
      fake.count((url) => url.pathname.endsWith("/events")) - before,
    ).toBeLessThan(10);
  });

  it("ignores forged, stale or misdirected notifications (same answer, no sync)", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const calendarId = (await calendarsOf(s)).find((item) => item.blocking)!.id;
    const channel = (await currentChannel(calendarId))!;
    const token = fake.channels.get(channel.channel_id)!.token;
    const valid = {
      "x-goog-channel-id": channel.channel_id,
      "x-goog-resource-id": channel.channel_resource_id,
      "x-goog-channel-token": token,
      "x-goog-resource-state": "exists",
    };

    for (const headers of [
      { ...valid, "x-goog-channel-id": randomUUID() },
      { ...valid, "x-goog-channel-token": "guess" },
      { ...valid, "x-goog-resource-id": "res-other" },
      { ...valid, "x-goog-resource-state": "sync" },
      { "x-goog-channel-id": "not-a-uuid" },
      {},
    ]) {
      const response = await webhook(
        notification(headers as Record<string, string>),
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect(background).toHaveLength(0);

    // Expired channel.
    await db.query(
      "update private.external_calendar_sync set channel_expires_at = now() - interval '1 minute' where calendar_id = $1",
      [calendarId],
    );
    await webhook(notification(valid));
    expect(background).toHaveLength(0);

    // Renewed by the job: the old channel is stopped and no longer accepted.
    const response = await cronGet(
      new Request("http://localhost/api/cron/calendar", {
        headers: { authorization: `Bearer ${"c".repeat(40)}` },
      }),
    );
    expect(response.status).toBe(200);
    const renewed = (await currentChannel(calendarId))!;
    expect(renewed.channel_id).not.toBe(channel.channel_id);
    expect(fake.channels.get(channel.channel_id)?.stopped).toBe(true);
    await webhook(notification(valid));
    expect(background).toHaveLength(0);
    const fresh = {
      ...valid,
      "x-goog-channel-id": renewed.channel_id,
      "x-goog-channel-token": fake.channels.get(renewed.channel_id)!.token,
    };
    await webhook(notification(fresh));
    expect(background).toHaveLength(1);
  });

  it("the periodic job refuses a wrong secret", async () => {
    for (const authorization of [
      "",
      "Bearer nope",
      `Bearer ${"c".repeat(39)}`,
    ]) {
      const response = await cronGet(
        new Request("http://localhost/api/cron/calendar", {
          headers: { authorization },
        }),
      );
      expect(response.status).toBe(401);
    }
  });
});

describe("disconnect", () => {
  it("removes every busy period, calendar and secret, stops channels, revokes; appointments untouched; idempotent", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const calendarId = (await calendarsOf(s)).find((item) => item.blocking)!.id;
    const channel = (await currentChannel(calendarId))!;
    const token = fake.channels.get(channel.channel_id)!.token;
    const client = await createClientRecord(s.business.id, "c@x.test");
    const appointment = await insertAppointment({
      businessId: s.business.id,
      clientId: client,
      serviceId: s.service,
      startsAt: at(D2, "09:00"),
      endsAt: at(D2, "10:00"),
    });

    sessionClient = s.owner.client;
    expect(ok(await disconnectGoogleCalendarAction())).toEqual({
      disconnected: true,
    });
    expect(ok(await disconnectGoogleCalendarAction())).toEqual({
      disconnected: true,
    });

    expect(await storedEvents(s)).toHaveLength(0);
    expect(await slots(s)).toContain(`${D}T09:00:00.000Z`);
    const counts = await db.query(
      `select (select count(*) from public.external_calendars where business_id = $1)::int as calendars,
              (select count(*) from private.calendar_secrets s join public.calendar_connections c on c.id = s.connection_id where c.business_id = $1)::int as secrets,
              (select status from public.calendar_connections where business_id = $1) as status,
              (select status from public.appointments where id = $2) as appointment`,
      [s.business.id, appointment],
    );
    expect(counts.rows[0]).toEqual({
      calendars: 0,
      secrets: 0,
      status: "disconnected",
      appointment: "confirmed",
    });
    expect(fake.channels.get(channel.channel_id)?.stopped).toBe(true);
    expect(fake.revoked).toHaveLength(1);

    await webhook(
      notification({
        "x-goog-channel-id": channel.channel_id,
        "x-goog-resource-id": channel.channel_resource_id,
        "x-goog-channel-token": token,
        "x-goog-resource-state": "exists",
      }),
    );
    expect(background).toHaveLength(0);
    expect(failed(await syncGoogleCalendarNowAction())).toBe(
      "calendar_not_connected",
    );
    expect(
      ok(await getCalendarIntegrationStatusAction()).connection,
    ).toMatchObject({ status: "disconnected", accountEmail: null });
  });

  it("a sync page arriving after the disconnection is not applied", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const calendarId = (await calendarsOf(s)).find((item) => item.blocking)!.id;
    const { rows } = await db.query(
      "select generation from private.external_calendar_sync where calendar_id = $1",
      [calendarId],
    );
    const connection = await db.query(
      "select id from public.calendar_connections where business_id = $1",
      [s.business.id],
    );

    // Simulates a worker that read Google before the disconnection.
    await admin.rpc("calendar_disconnect", {
      p_connection_id: connection.rows[0].id,
    });
    const late = await admin.rpc("calendar_apply_events", {
      p_calendar_id: calendarId,
      p_generation: rows[0]?.generation ?? 1,
      p_events: [
        {
          id: "late",
          start: { dateTime: at(D, "09:00") },
          end: { dateTime: at(D, "10:00") },
        },
      ],
    });
    expect(late.error ?? late.data).toMatchObject(
      late.error ? { message: "calendar_not_found" } : { applied: false },
    );
    expect(await storedEvents(s)).toHaveLength(0);
  });
});

describe("availability and booking", () => {
  it("a busy period removes overlapping slots; touching bounds are free; the buffer applies before it", async () => {
    const s = await setup({ buffer: 15 });
    await connect(s);
    fake.putEvent(work(s), timed("dentist", D, "14:00", "15:00"));
    await select(s, ["Travail"]);

    const free = await slots(s);
    // 60-minute service + 15-minute buffer must end by 14:00.
    expect(free).toContain(`${D}T12:30:00.000Z`);
    expect(free).not.toContain(`${D}T13:00:00.000Z`);
    expect(free).not.toContain(`${D}T14:00:00.000Z`);
    expect(free).toContain(`${D}T15:00:00.000Z`);

    await expect(book(s, `${D}T15:00:00.000Z`)).resolves.toBe(
      `${D}T15:00:00.000Z`,
    );
    await expect(book(s, `${D}T13:00:00.000Z`)).rejects.toMatchObject({
      message: "slot_unavailable",
    });
  });

  it("the booking transaction refuses an overlap synced after the listing", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    expect(await slots(s)).toContain(`${D}T10:00:00.000Z`);

    fake.putEvent(work(s), timed("late", D, "10:30", "11:00"));
    await syncNow(s);
    await expect(book(s, `${D}T10:00:00.000Z`)).rejects.toMatchObject({
      message: "slot_unavailable",
    });
    await expect(book(s, `${D}T11:00:00.000Z`)).resolves.toBe(
      `${D}T11:00:00.000Z`,
    );
  });

  it("a sync waits for a booking holding the schedule lock, then stores the conflict without touching it", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);

    const booking = await openTransaction();
    await booking.connection.query(
      `select * from private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Cliente', $4)`,
      [s.business.slug, s.service, `${D}T10:00:00Z`, `${randomUUID()}@x.test`],
    );

    fake.putEvent(work(s), timed("overlap", D, "10:30", "11:30"));
    const sync = syncNow(s);
    await waitUntilBlocked(await waitPid());
    await booking.connection.query("commit");
    booking.connection.release();
    await sync;

    expect((await storedEvents(s)).map((row) => row.provider_event_id)).toEqual(
      ["overlap"],
    );
    const { rows } = await db.query(
      "select status from public.appointments where business_id = $1",
      [s.business.id],
    );
    expect(rows.map((row) => row.status)).toEqual(["confirmed"]);
    sessionClient = s.owner.client;
    const conflicts = ok(
      await listCalendarConflictsAction({
        from: `${D}T00:00:00Z`,
        to: `${D2}T00:00:00Z`,
      }),
    );
    expect(conflicts).toEqual([
      expect.objectContaining({
        appointmentStartsAt: `${D}T10:00:00.000Z`,
        eventStartsAt: `${D}T10:30:00.000Z`,
      }),
    ]);

    // Finds the backend applying the page while the booking holds the lock.
    async function waitPid() {
      for (let i = 0; i < 100; i += 1) {
        const { rows: waiting } = await db.query<{ pid: number }>(
          `select pid from pg_stat_activity
           where wait_event_type = 'Lock' and query like '%calendar_apply_events%'`,
        );
        if (waiting[0]) return waiting[0].pid;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("The sync never waited for the schedule lock");
    }
  });

  it("a professional may still place an appointment over an external event (reported as a conflict)", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("busy", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const created = await createManualAppointment(
      s.owner.client,
      { businessId: s.business.id, timezone: "UTC" },
      {
        date: D,
        time: "09:00",
        occurrence: undefined,
        serviceId: s.service,
        client: {
          type: "new",
          firstName: "Agenda",
          lastName: null,
          email: null,
          phone: null,
        },
        internalNotes: null,
      },
    );
    expect(created.appointment.startsAt).toBe(`${D}T09:00:00.000Z`);
    sessionClient = s.owner.client;
    expect(
      ok(
        await listCalendarConflictsAction({
          from: `${D}T00:00:00Z`,
          to: `${D2}T00:00:00Z`,
        }),
      ),
    ).toHaveLength(1);
  });
});

describe("tenant isolation and secrets", () => {
  it("another business sees nothing and changes nothing", async () => {
    const a = await setup();
    const b = await setup();
    await connect(a);
    fake.putEvent(work(a), timed("a1", D, "09:00", "10:00"));
    const aCalendars = await select(a, ["Travail"]);

    sessionClient = b.owner.client;
    for (const table of [
      "calendar_connections",
      "external_calendars",
      "external_calendar_events",
    ] as const) {
      const { data } = await b.owner.client.from(table).select("id");
      expect(data).toEqual([]);
    }
    expect(
      failed(await updateBlockingCalendarsAction({ calendarIds: aCalendars })),
    ).toBe("calendar_not_connected");
    await connect(b);
    expect(
      failed(await updateBlockingCalendarsAction({ calendarIds: aCalendars })),
    ).toBe("calendar_not_found");
    const direct = await b.owner.client.rpc("calendar_set_blocking", {
      p_business_id: a.business.id,
      p_calendar_ids: [],
    });
    expect(direct.error?.message).toBe("forbidden");
    const conflicts = await b.owner.client.rpc("calendar_conflicts", {
      p_business_id: a.business.id,
      p_from: `${D}T00:00:00Z`,
      p_to: `${D2}T00:00:00Z`,
    });
    expect(conflicts.error?.message).toBe("forbidden");
    ok(await syncGoogleCalendarNowAction());
    expect(await storedEvents(a)).toHaveLength(1);
  });

  it("credentials and sync functions are out of reach of API roles", async () => {
    const s = await setup();
    await connect(s);
    const connection = (
      await db.query(
        "select id from public.calendar_connections where business_id = $1",
        [s.business.id],
      )
    ).rows[0].id;

    for (const client of [s.owner.client, anonClient()]) {
      const secrets = await client.rpc("calendar_read_secrets", {
        p_connection_id: connection,
      });
      expect(secrets.error?.code).toBe("42501");
      const disconnect = await client.rpc("calendar_disconnect", {
        p_connection_id: connection,
      });
      expect(disconnect.error?.code).toBe("42501");
      const claim = await client.rpc("calendar_claim_sync", {
        p_calendar_id: randomUUID(),
      });
      expect(claim.error?.code).toBe("42501");
    }
    const anonStatus = await anonClient()
      .from("calendar_connections")
      .select("id");
    expect(anonStatus.error?.code).toBe("42501");
    // Even the owner cannot read a token column or write the tables directly.
    const tokenColumn = await s.owner.client
      .from("calendar_connections")
      .select("provider_account_id");
    expect(tokenColumn.error?.code).toBe("42501");
    const write = await s.owner.client
      .from("external_calendars")
      .update({ selected_for_blocking: true })
      .eq("business_id", s.business.id);
    expect(write.error?.code).toBe("42501");
    const { rows } = await db.query(
      `select has_schema_privilege('authenticated', 'private', 'usage') as auth,
              has_function_privilege('authenticated', 'public.calendar_apply_events(uuid, bigint, jsonb, text)', 'execute') as apply`,
    );
    expect(rows[0]).toEqual({ auth: false, apply: false });
  });
});

describe("configuration", () => {
  it("fails closed without configuration", async () => {
    const s = await setup();
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
    sessionClient = s.owner.client;
    expect(failed(await startGoogleCalendarConnectAction())).toBe(
      "calendar_not_configured",
    );
    expect(ok(await getCalendarIntegrationStatusAction())).toMatchObject({
      available: false,
      connection: null,
    });
    const response = await webhook(
      notification({ "x-goog-channel-id": randomUUID() }),
    );
    expect(response.status).toBe(204);
  });
});
