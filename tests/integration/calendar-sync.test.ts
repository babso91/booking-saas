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
import { runCalendarJob } from "@/features/calendar/data/cron";
import { getCalendarDeps } from "@/features/calendar/data/deps";
import { syncCalendar } from "@/features/calendar/data/sync";
import { describeSyncStatus } from "@/features/calendar/client/sync-status-copy";
import { getAccessToken } from "@/features/calendar/data/tokens";
import {
  decryptSecret,
  encryptSecret,
  secretKey,
  secretKeyId,
} from "@/lib/crypto/secret-box";
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
import {
  closeTransaction,
  openTransaction,
  waitUntilBlocked,
  type OpenTransaction,
} from "./support/transactions";

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
// The service-role client the server code uses, with optional hooks run
// before an RPC is sent or after its answer arrived (to interleave a
// concurrent write, or to delay an answer as a slow network would).
const rpcHooks = new Map<
  string,
  { before?: () => Promise<void>; after?: () => Promise<void> }
>();
/** RPCs the server code sent (name, abort signal if any), in order. */
const rpcCalls: { name: string; signal?: AbortSignal }[] = [];
const serverAdmin = new Proxy(admin, {
  get(target, property, receiver) {
    if (property !== "rpc") return Reflect.get(target, property, receiver);
    // A thenable builder like PostgREST's, supporting abortSignal().
    return (...args: Parameters<typeof admin.rpc>) => {
      const call: { name: string; signal?: AbortSignal } = {
        name: args[0] as string,
      };
      let running: Promise<unknown> | undefined;
      const run = async () => {
        rpcCalls.push(call);
        const hook = rpcHooks.get(call.name);
        await hook?.before?.();
        let query = target.rpc(...args);
        if (call.signal) query = query.abortSignal(call.signal);
        const answer = await query;
        await hook?.after?.();
        return answer;
      };
      const builder = {
        abortSignal(signal: AbortSignal) {
          call.signal = signal;
          return builder;
        },
        then(
          resolve?: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          running ??= run();
          return running.then(resolve, reject);
        },
      };
      return builder;
    };
  },
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => serverAdmin,
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
  rpcHooks.clear();
  rpcCalls.length = 0;
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
      .filter(
        (request) =>
          request.url.pathname.endsWith("/events") &&
          !request.url.searchParams.has("syncToken"),
      )
      .slice(-4);
    expect(resumed[0]!.url.searchParams.get("pageToken")).toBe("2");
    expect(
      (await calendarsOf(s)).find((item) => item.blocking)!.syncStatus,
    ).toBe("synced");
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
      syncStatus: "incomplete",
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
    // The job's queue is global (round robin, least recently attempted
    // first): put this calendar at its head so that calendars left by other
    // tests never decide whether it is reached.
    await db.query(
      "update private.external_calendar_sync set last_attempt_at = null where calendar_id = $1",
      [calendarId],
    );
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
    const connection = await db.query(
      "select id, credential_generation from public.calendar_connections where business_id = $1",
      [s.business.id],
    );
    // A worker claims the calendar and reads Google…
    const claim = (
      await admin.rpc("calendar_claim_sync", {
        p_calendar_id: calendarId,
      })
    ).data as { claimId: string };
    const start = (
      await admin.rpc("calendar_start_full_sync", {
        p_calendar_id: calendarId,
        p_claim_id: claim.claimId,
      })
    ).data as { generation: number };

    // …then the professional disconnects before the page is applied.
    await admin.rpc("calendar_disconnect", {
      p_connection_id: connection.rows[0].id,
      p_generation: connection.rows[0].credential_generation,
    });
    const late = await admin.rpc("calendar_apply_events", {
      p_calendar_id: calendarId,
      p_claim_id: claim.claimId,
      p_generation: start.generation,
      p_provider_timezone: "UTC",
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

    // Finds the sync backend waiting for the lock the booking holds (the
    // claim or the page, both take the schedule lock first).
    async function waitPid() {
      for (let i = 0; i < 100; i += 1) {
        const { rows: waiting } = await db.query<{ pid: number }>(
          `select pid from pg_stat_activity
           where wait_event_type = 'Lock'
             and (query like '%calendar_apply_events%' or query like '%calendar_claim_sync%')`,
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
        p_generation: randomUUID(),
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
              has_function_privilege('authenticated', 'public.calendar_apply_events(uuid, uuid, bigint, text, jsonb, text)', 'execute') as apply,
              has_function_privilege('authenticated', 'public.calendar_release_sync(uuid, uuid, text, text)', 'execute') as release,
              has_function_privilege('authenticated', 'public.calendar_reencrypt_secrets(uuid, uuid, bigint, text, text)', 'execute') as reencrypt,
              has_function_privilege('anon', 'public.calendar_save_calendars(uuid, uuid, jsonb)', 'execute') as save`,
    );
    expect(rows[0]).toEqual({
      auth: false,
      apply: false,
      release: false,
      reencrypt: false,
      save: false,
    });
    // The incarnation is not exposed to the professional either.
    const generation = await s.owner.client
      .from("calendar_connections")
      .select("credential_generation");
    expect(generation.error?.code).toBe("42501");
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

// ---------------------------------------------------------------------------
// Hardening (audit of 08a8013): incarnations, claims, generations, protocol,
// time zones, fairness, channel renewal, lifecycle races.
// ---------------------------------------------------------------------------

function otherAccount() {
  const account = {
    sub: `sub-${randomUUID()}`,
    email: `${randomUUID().slice(0, 6)}@gmail.test`,
  };
  fake.setCalendars(account.sub, [
    { id: account.email, summary: "Perso B", timeZone: "UTC", primary: true },
    { id: `work-${account.sub}`, summary: "Travail B", timeZone: "UTC" },
  ]);
  return account;
}

async function connectionRow(s: Setup) {
  const { rows } = await db.query<{
    id: string;
    status: string;
    provider_account_id: string;
    credential_generation: string;
    revocation_pending_until: Date | null;
  }>(
    `select id, status, provider_account_id, credential_generation, revocation_pending_until
     from public.calendar_connections where business_id = $1`,
    [s.business.id],
  );
  return rows[0]!;
}

async function secretsRow(s: Setup) {
  const { rows } = await db.query<{
    refresh_token_ciphertext: string;
    access_token_ciphertext: string | null;
  }>(
    `select s.refresh_token_ciphertext, s.access_token_ciphertext
     from private.calendar_secrets s
     join public.calendar_connections c on c.id = s.connection_id
     where c.business_id = $1`,
    [s.business.id],
  );
  return rows[0];
}

async function providerCalendarIds(s: Setup) {
  const { rows } = await db.query<{ provider_calendar_id: string }>(
    `select provider_calendar_id from public.external_calendars
     where business_id = $1 order by provider_calendar_id`,
    [s.business.id],
  );
  return rows.map((row) => row.provider_calendar_id);
}

async function expireStoredAccessToken(s: Setup) {
  await db.query(
    `update private.calendar_secrets set access_token_expires_at = now()
     where connection_id = (select id from public.calendar_connections where business_id = $1)`,
    [s.business.id],
  );
}

async function syncState(calendarId: string) {
  const { rows } = await db.query<{
    generation: string;
    allocated_generation: string;
    full_generation: string | null;
    full_page_token: string | null;
    sync_token: string | null;
    claim_id: string | null;
    lease_until: Date | null;
    failure_count: number;
    next_attempt_at: Date | null;
    sync_status: string;
    last_error: string | null;
  }>(
    `select s.generation, s.allocated_generation, s.full_generation, s.full_page_token,
            s.sync_token, s.claim_id, s.lease_until, s.failure_count, s.next_attempt_at,
            c.sync_status, c.last_error
     from private.external_calendar_sync s
     join public.external_calendars c on c.id = s.calendar_id
     where s.calendar_id = $1`,
    [calendarId],
  );
  const row = rows[0]!;
  return {
    ...row,
    generation: Number(row.generation),
    allocated_generation: Number(row.allocated_generation),
    full_generation:
      row.full_generation === null ? null : Number(row.full_generation),
  };
}

async function blockingId(s: Setup) {
  return (await calendarsOf(s)).find((item) => item.blocking)!.id;
}

const eventIds = async (s: Setup) =>
  (await storedEvents(s)).map((row) => row.provider_event_id);

const isEventsList = (url: URL, method: string) =>
  method === "GET" && url.pathname.endsWith("/events");

async function claim(calendarId: string) {
  const { data, error } = await admin.rpc("calendar_claim_sync", {
    p_calendar_id: calendarId,
  });
  if (error) throw error;
  return data as { claimed: boolean; claimId: string };
}

async function expireLease(calendarId: string) {
  await db.query(
    `update private.external_calendar_sync
     set lease_until = now() - interval '1 second' where calendar_id = $1`,
    [calendarId],
  );
}

const pageEvent = (id: string, from: string, to: string) => ({
  id,
  status: "confirmed",
  start: { dateTime: at(D, from) },
  end: { dateTime: at(D, to) },
});

describe("connection incarnations", () => {
  it("A: a refresh of the former account finishing after a reconnection never overwrites the new credentials", async () => {
    const s = await setup();
    await connect(s);
    await expireStoredAccessToken(s);
    const B = otherAccount();

    const held = fake.hold(
      (url, method) => url.pathname === "/token" && method === "POST",
    );
    sessionClient = s.owner.client;
    const pending = listConnectedCalendarsAction({ refresh: true });
    await held.reached;

    await connect(s, B);
    const afterB = await secretsRow(s);
    const generationB = (await connectionRow(s)).credential_generation;

    held.release();
    expect(failed(await pending)).toBe("conflict");
    expect(await secretsRow(s)).toEqual(afterB);
    expect(await connectionRow(s)).toMatchObject({
      status: "active",
      provider_account_id: B.sub,
      credential_generation: generationB,
    });
    // B's stored credentials still work.
    await select(s, ["Travail B"]);
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
  });

  it("B: a calendar list of the former account arriving after a reconnection is not saved", async () => {
    const s = await setup();
    await connect(s);
    const B = otherAccount();

    const held = fake.hold((url) => url.pathname.endsWith("/calendarList"));
    sessionClient = s.owner.client;
    const pending = listConnectedCalendarsAction({ refresh: true });
    await held.reached;
    await connect(s, B);
    held.release();

    // The answer shows the current (B) incarnation; A's list was dropped.
    const listed = ok(await pending);
    expect(listed.map((calendar) => calendar.name).sort()).toEqual([
      "Perso B",
      "Travail B",
    ]);
    expect(await providerCalendarIds(s)).toEqual(
      [B.email, `work-${B.sub}`].sort(),
    );
  });

  it("C: a sync page of the former account arriving after a reconnection is never applied", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    fake.putEvent(work(s), timed("a-late", D, "11:00", "12:00"));
    const B = otherAccount();

    const held = fake.hold(isEventsList);
    const pending = syncNow(s);
    await held.reached;
    await connect(s, B);
    held.release();
    await pending;

    expect(await storedEvents(s)).toEqual([]);
    expect(await providerCalendarIds(s)).not.toContain(work(s));
  });

  it("C': same account reconnected during a sync: the former pass writes nothing, the new one syncs", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    fake.putEvent(work(s), timed("x", D, "11:00", "12:00"));

    const held = fake.hold(isEventsList);
    const pending = syncCalendar(getCalendarDeps(), calendarId);
    await held.reached;
    // X deleted at Google, then the professional reconnects (resync).
    fake.deleteEvent(work(s), "x");
    await connect(s);
    expect(await eventIds(s)).toEqual([]);
    held.release();
    expect(await pending).toBe("superseded");
    expect(await eventIds(s)).toEqual([]);
  });

  it("D: an invalid_grant of the former account after a reconnection leaves the new one active", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    await expireStoredAccessToken(s);
    fake.revokeAll();
    const B = otherAccount();

    const held = fake.hold(
      (url, method) => url.pathname === "/token" && method === "POST",
    );
    const pending = syncCalendar(getCalendarDeps(), await blockingId(s));
    await held.reached;
    await connect(s, B);
    held.release();

    expect(await pending).toBe("superseded");
    expect(await connectionRow(s)).toMatchObject({
      status: "active",
      provider_account_id: B.sub,
    });
  });

  it("E: two concurrent callbacks: the last one wins entirely (account, calendars, credentials)", async () => {
    const s = await setup();
    const B = otherAccount();
    const first = await beginConnect(s);
    const second = await beginConnect(s, B);

    const held = fake.hold(
      (url, method) => url.pathname === "/token" && method === "POST",
    );
    const pendingA = oauthCallback(callbackRequest(first));
    await held.reached;
    expect(resultOf(await oauthCallback(callbackRequest(second)))).toBe(
      "connected",
    );
    const generationB = (await connectionRow(s)).credential_generation;
    held.release();
    expect(resultOf(await pendingA)).toBe("connected");
    await flush();

    const { rows } = await db.query(
      "select count(*)::int as n from public.calendar_connections where business_id = $1",
      [s.business.id],
    );
    expect(rows[0].n).toBe(1);
    const connection = await connectionRow(s);
    expect(connection.provider_account_id).toBe(s.account.sub);
    expect(connection.credential_generation).not.toBe(generationB);
    expect(await providerCalendarIds(s)).toEqual(
      [s.account.email, work(s), `birthdays-${s.account.sub}`].sort(),
    );
    // The stored credentials are A's and work.
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    expect(await eventIds(s)).toEqual(["a"]);
  });
});

describe("sync claims", () => {
  async function synced() {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    return { s, calendarId: await blockingId(s) };
  }

  it("A: after a takeover, the former worker's page, finish and release are no-ops", async () => {
    const { s, calendarId } = await synced();
    const a = await claim(calendarId);
    const startA = (
      await admin.rpc("calendar_start_full_sync", {
        p_calendar_id: calendarId,
        p_claim_id: a.claimId,
      })
    ).data as { generation: number };

    await expireLease(calendarId);
    const b = await claim(calendarId);
    expect(b.claimed).toBe(true);
    const startB = (
      await admin.rpc("calendar_start_full_sync", {
        p_calendar_id: calendarId,
        p_claim_id: b.claimId,
      })
    ).data as { generation: number };
    expect(startB.generation).toBeGreaterThan(startA.generation);
    await admin.rpc("calendar_apply_events", {
      p_calendar_id: calendarId,
      p_claim_id: b.claimId,
      p_generation: startB.generation,
      p_provider_timezone: "UTC",
      p_events: [pageEvent("b", "13:00", "14:00")],
    });
    expect(
      (
        await admin.rpc("calendar_finish_full_sync", {
          p_calendar_id: calendarId,
          p_claim_id: b.claimId,
          p_generation: startB.generation,
          p_sync_token: "sync-b",
        })
      ).data,
    ).toBe(true);

    // A answers late: nothing it sends is written.
    const late = await admin.rpc("calendar_apply_events", {
      p_calendar_id: calendarId,
      p_claim_id: a.claimId,
      p_generation: startA.generation,
      p_provider_timezone: "UTC",
      p_events: [pageEvent("from-a", "15:00", "16:00")],
    });
    expect(late.data).toEqual({ applied: false, reason: "stale_claim" });
    expect(
      (
        await admin.rpc("calendar_finish_full_sync", {
          p_calendar_id: calendarId,
          p_claim_id: a.claimId,
          p_generation: startA.generation,
          p_sync_token: "sync-a",
        })
      ).data,
    ).toBe(false);
    expect(await eventIds(s)).toEqual(["b"]);
    expect((await syncState(calendarId)).sync_token).toBe("sync-b");
  });

  it("B: the former worker's release does not release the current claim", async () => {
    const { calendarId } = await synced();
    const a = await claim(calendarId);
    await expireLease(calendarId);
    const b = await claim(calendarId);

    const released = await admin.rpc("calendar_release_sync", {
      p_calendar_id: calendarId,
      p_claim_id: a.claimId,
      p_outcome: "error",
      p_error: "from_a",
    });
    expect(released.data).toBe(false);
    const state = await syncState(calendarId);
    expect(state).toMatchObject({
      claim_id: b.claimId,
      sync_status: "syncing",
      failure_count: 0,
    });
    expect(state.lease_until).not.toBeNull();
    expect(state.last_error).toBeNull();
    // A new worker cannot take over while B's lease runs.
    expect((await claim(calendarId)).claimed).toBe(false);
  });

  it("C: the former worker's cursor is refused after a takeover", async () => {
    const { calendarId } = await synced();
    const before = (await syncState(calendarId)).sync_token;
    const a = await claim(calendarId);
    await expireLease(calendarId);
    const b = await claim(calendarId);

    const finishA = await admin.rpc("calendar_finish_incremental_sync", {
      p_calendar_id: calendarId,
      p_claim_id: a.claimId,
      p_sync_token: "sync-from-a",
    });
    expect(finishA.data).toBe(false);
    expect((await syncState(calendarId)).sync_token).toBe(before);
    const resetA = await admin.rpc("calendar_reset_sync", {
      p_calendar_id: calendarId,
      p_claim_id: a.claimId,
    });
    expect(resetA.data).toBe(false);
    expect((await syncState(calendarId)).sync_token).toBe(before);

    const finishB = await admin.rpc("calendar_finish_incremental_sync", {
      p_calendar_id: calendarId,
      p_claim_id: b.claimId,
      p_sync_token: "sync-from-b",
    });
    expect(finishB.data).toBe(true);
  });

  it("D: deselecting then reselecting revokes the running worker's claim", async () => {
    const { s, calendarId } = await synced();
    const a = await claim(calendarId);
    sessionClient = s.owner.client;
    ok(await updateBlockingCalendarsAction({ calendarIds: [] }));
    ok(await updateBlockingCalendarsAction({ calendarIds: [calendarId] }));
    background.length = 0;

    const late = await admin.rpc("calendar_apply_events", {
      p_calendar_id: calendarId,
      p_claim_id: a.claimId,
      p_generation: null as unknown as number,
      p_provider_timezone: "UTC",
      p_events: [pageEvent("from-a", "15:00", "16:00")],
    });
    expect(late.data).toEqual({ applied: false, reason: "stale_claim" });
    const record = await admin.rpc("calendar_record_channel", {
      p_calendar_id: calendarId,
      p_claim_id: a.claimId,
      p_channel_id: randomUUID(),
      p_resource_id: "res-x",
      p_token_hash: "0".repeat(64),
      p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(record.data).toMatchObject({ orphan: true });
    expect(await eventIds(s)).toEqual([]);
  });

  it("a worker whose answer arrives after a takeover writes nothing (end to end)", async () => {
    const { s, calendarId } = await synced();
    fake.putEvent(work(s), timed("n", D, "11:00", "12:00"));

    const held = fake.hold(isEventsList);
    const workerA = syncCalendar(getCalendarDeps(), calendarId);
    await held.reached;
    await expireLease(calendarId);
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    // n deleted meanwhile, and synced so.
    fake.deleteEvent(work(s), "n");
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    expect(await eventIds(s)).toEqual(["a"]);

    held.release();
    expect(await workerA).toBe("superseded");
    expect(await eventIds(s)).toEqual(["a"]);
    expect((await syncState(calendarId)).sync_status).toBe("synced");
  });

  it("a pass never outlives its deadline: every provider call gets the remaining budget", async () => {
    const { calendarId } = await synced();
    const held = fake.hold(isEventsList);
    const started = Date.now();
    const outcome = await syncCalendar(getCalendarDeps(), calendarId, {
      budgetMs: 1500,
    });
    const elapsed = Date.now() - started;
    held.release();

    expect(outcome).toBe("stale");
    expect(elapsed).toBeLessThan(4000);
    expect(await syncState(calendarId)).toMatchObject({
      sync_status: "stale",
      last_error: "budget_exceeded",
      claim_id: null,
      lease_until: null,
    });
  });
});

describe("full sync generations", () => {
  async function interruptedAttempt() {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("y", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    expect((await syncState(calendarId)).generation).toBe(1);

    // gen 2 imports X (page 2), then fails on page 3.
    fake.pageSize = 1;
    fake.putEvent(work(s), timed("x", D, "11:00", "12:00"));
    fake.putEvent(work(s), timed("w", D, "14:00", "15:00"));
    fake.expireSyncTokens();
    fake.failNext(
      (url) =>
        url.pathname.endsWith("/events") &&
        url.searchParams.get("pageToken") === "2",
      403,
      1,
      { error: { errors: [{ reason: "forbidden" }] } },
    );
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("error");
    expect(await eventIds(s)).toEqual(["y", "x"]);
    expect(await syncState(calendarId)).toMatchObject({
      generation: 1,
      full_generation: 2,
      full_page_token: "2",
    });
    // X is then deleted at Google.
    fake.deleteEvent(work(s), "x");
    return { s, calendarId };
  }

  it("an abandoned attempt is never resumed: the restart gets a new generation and its sweep removes X", async () => {
    const { s, calendarId } = await interruptedAttempt();
    await db.query(
      `update private.external_calendar_sync
       set full_started_at = now() - interval '2 hours', next_attempt_at = null
       where calendar_id = $1`,
      [calendarId],
    );
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    expect(await eventIds(s)).toEqual(["y", "w"]);
    expect(await syncState(calendarId)).toMatchObject({
      generation: 3,
      allocated_generation: 3,
      full_generation: null,
      sync_status: "synced",
    });
  });

  it("a resumed page cursor the provider rejects (410) restarts from page 1 with a new generation", async () => {
    const { s, calendarId } = await interruptedAttempt();
    fake.failNext(
      (url) =>
        url.pathname.endsWith("/events") &&
        url.searchParams.get("pageToken") === "2",
      410,
    );
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    expect(await eventIds(s)).toEqual(["y", "w"]);
    expect((await syncState(calendarId)).generation).toBe(3);
  });

  it("a real resume continues its own attempt (same generation)", async () => {
    const { calendarId } = await interruptedAttempt();
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    const resumed = fake.requests.filter(
      (request) =>
        request.url.pathname.endsWith("/events") &&
        !request.url.searchParams.has("syncToken"),
    );
    expect(resumed.at(-1)!.url.searchParams.get("pageToken")).toBe("2");
    expect((await syncState(calendarId)).generation).toBe(2);
  });

  it("an invalid sync token (410) leads to a full sync with a new generation", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("y", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    fake.expireSyncTokens();
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    expect(await syncState(calendarId)).toMatchObject({
      generation: 2,
      allocated_generation: 2,
    });
  });
});

describe("strict provider protocol", () => {
  const malformed: [string, unknown][] = [
    ["unparsable JSON", "<html>temporarily unavailable</html>"],
    ["an empty object", {}],
    ["items that are not an array", { items: {}, nextSyncToken: "sync-999" }],
    ["a last page without cursor", { items: [] }],
    [
      "both cursors",
      { items: [], nextPageToken: "1", nextSyncToken: "sync-999" },
    ],
    [
      "an event without id",
      {
        items: [{ status: "confirmed", ...timed("", D, "10:00", "11:00") }],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "an event without bounds",
      { items: [{ id: "x", status: "confirmed" }], nextSyncToken: "sync-999" },
    ],
    [
      "an empty interval",
      {
        items: [{ ...timed("a", D, "10:00", "10:00") }],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "an inverted interval",
      {
        items: [{ ...timed("a", D, "10:00", "09:00") }],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "an attendee self given as a string",
      {
        items: [
          {
            ...timed("a", D, "09:00", "10:00"),
            attendees: [{ self: "false", responseStatus: "declined" }],
          },
        ],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "an attendee self given as a number",
      {
        items: [
          {
            ...timed("a", D, "09:00", "10:00"),
            attendees: [{ self: 1, responseStatus: "declined" }],
          },
        ],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "an unknown response status",
      {
        items: [
          {
            ...timed("a", D, "09:00", "10:00"),
            attendees: [{ self: true, responseStatus: "maybe" }],
          },
        ],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "a malformed offset",
      {
        items: [
          {
            id: "a",
            start: { dateTime: `${D}T09:00:00+25:00` },
            end: { dateTime: at(D, "10:00") },
          },
        ],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "an invalid all-day shape",
      {
        items: [{ id: "a", start: { date: `${D}T00:00` }, end: { date: D2 } }],
        nextSyncToken: "sync-999",
      },
    ],
    [
      "an event with mixed bounds",
      {
        items: [
          {
            id: "x",
            start: { date: D },
            end: { dateTime: at(D, "11:00") },
          },
        ],
        nextSyncToken: "sync-999",
      },
    ],
  ];

  it("a malformed events page fails the pass: no sweep, copy and cursor kept", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    fake.putEvent(work(s), timed("b", D, "11:00", "12:00"));
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    const before = await syncState(calendarId);

    for (const [, body] of malformed) {
      for (const mode of ["incremental", "full"] as const) {
        await db.query(
          `update private.external_calendar_sync
           set next_attempt_at = null,
               sync_token = case when $2 = 'full' then null else sync_token end
           where calendar_id = $1`,
          [calendarId, mode],
        );
        const cursor = (await syncState(calendarId)).sync_token;
        fake.failNext((url) => url.pathname.endsWith("/events"), 200, 1, body);
        expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("error");
        const state = await syncState(calendarId);
        expect(state).toMatchObject({
          sync_status: "error",
          last_error: "provider_protocol",
          generation: before.generation,
          sync_token: cursor,
        });
        expect(await eventIds(s)).toEqual(["a", "b"]);
        expect(await slots(s)).not.toContain(`${D}T09:00:00.000Z`);
      }
    }

    // A well-formed answer then synchronises normally.
    await db.query(
      "update private.external_calendar_sync set next_attempt_at = null where calendar_id = $1",
      [calendarId],
    );
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    expect(await eventIds(s)).toEqual(["a", "b"]);
  });

  it("a malformed, empty or truncated calendar list changes nothing", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const calendars = await providerCalendarIds(s);

    for (const [body, times] of [
      ["not json", 1],
      [{}, 1],
      [{ items: [] }, 1],
      [{ items: "x" }, 1],
      [{ items: [{ summary: "no id" }] }, 1],
      [{ items: [{ id: "c" }], nextPageToken: "more" }, 4],
    ] as [unknown, number][]) {
      fake.failNext(
        (url) => url.pathname.endsWith("/calendarList"),
        200,
        times,
        body,
      );
      sessionClient = s.owner.client;
      expect(
        failed(await listConnectedCalendarsAction({ refresh: true })),
      ).toBe("calendar_provider_unavailable");
      expect(await providerCalendarIds(s)).toEqual(calendars);
      expect(await eventIds(s)).toEqual(["a"]);
    }
  });

  it("an expired id_token is refused: nothing is stored", async () => {
    const s = await setup();
    fake.idTokenClaims = { exp: Math.floor(Date.now() / 1000) - 3600 };
    const { code, state } = await beginConnect(s);
    expect(
      resultOf(await oauthCallback(callbackRequest({ state, code }))),
    ).not.toBe("connected");
    const { rows } = await db.query(
      "select 1 from public.calendar_connections where business_id = $1",
      [s.business.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("calendar time zone changes", () => {
  async function dayStart(date: string, zone: string) {
    const { rows } = await db.query<{ at: Date }>(
      "select private.local_day_start($1::date, $2) as at",
      [date, zone],
    );
    return rows[0]!.at.toISOString();
  }

  it("re-projects all-day events after a change seen in the calendar list or an events page", async () => {
    const s = await setup();
    fake.setCalendars(s.account.sub, [
      {
        id: s.account.email,
        summary: "Personnel",
        timeZone: "UTC",
        primary: true,
      },
      { id: work(s), summary: "Travail", timeZone: "Europe/Paris" },
    ]);
    await connect(s);
    fake.putEvent(work(s), {
      id: "day",
      start: { date: D },
      end: { date: D2 },
    });
    fake.putEvent(work(s), {
      id: "timed",
      start: { dateTime: `${D}T10:00:00+02:00` },
      end: { dateTime: `${D}T11:00:00+02:00` },
    });
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    const projected = async () =>
      Object.fromEntries(
        (await storedEvents(s)).map((row) => [
          row.provider_event_id,
          [row.starts_at.toISOString(), row.ends_at.toISOString()],
        ]),
      );
    const timedInstant = [
      new Date(`${D}T08:00:00Z`).toISOString(),
      new Date(`${D}T09:00:00Z`).toISOString(),
    ];
    expect(await projected()).toEqual({
      day: [
        await dayStart(D, "Europe/Paris"),
        await dayStart(D2, "Europe/Paris"),
      ],
      timed: timedInstant,
    });

    // Paris → New York, seen by a calendar list refresh.
    fake.setTimeZone(work(s), "America/New_York");
    sessionClient = s.owner.client;
    const refreshed = ok(await listConnectedCalendarsAction({ refresh: true }));
    expect(refreshed.find((item) => item.id === calendarId)).toMatchObject({
      timezone: "America/New_York",
      syncStatus: "stale",
    });
    await flush();
    expect(await projected()).toEqual({
      day: [
        await dayStart(D, "America/New_York"),
        await dayStart(D2, "America/New_York"),
      ],
      timed: timedInstant,
    });
    expect(await syncState(calendarId)).toMatchObject({
      generation: 2,
      sync_status: "synced",
    });

    // New York → Paris, seen in an events page only.
    fake.setTimeZone(work(s), "Europe/Paris");
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
    expect(await projected()).toEqual({
      day: [
        await dayStart(D, "Europe/Paris"),
        await dayStart(D2, "Europe/Paris"),
      ],
      timed: timedInstant,
    });
    expect((await syncState(calendarId)).generation).toBe(3);
    expect(
      (await calendarsOf(s)).find((item) => item.id === calendarId),
    ).toMatchObject({ timezone: "Europe/Paris", syncStatus: "synced" });
  });
});

describe("periodic job fairness", () => {
  it(
    "50 failing calendars never starve a healthy 51st",
    { timeout: 120_000 },
    async () => {
      const s = await setup();
      const calendars = Array.from({ length: 51 }, (_, index) => ({
        id: `cal-${index}-${s.account.sub}`,
        summary: `Calendrier ${index}`,
        timeZone: "UTC",
        primary: index === 0,
      }));
      fake.setCalendars(s.account.sub, calendars);
      await connect(s);
      const healthy = calendars[50]!.id;
      fake.putEvent(healthy, timed("h", D, "09:00", "10:00"));
      const broken = new Set(calendars.slice(0, 50).map((item) => item.id));
      fake.failNext(
        (url) =>
          [...broken].some((id) =>
            url.pathname.includes(`/calendars/${encodeURIComponent(id)}/`),
          ),
        403,
        10_000,
        { error: { errors: [{ reason: "forbidden" }] } },
      );
      await db.query(
        `update public.external_calendars set selected_for_blocking = true
       where business_id = $1`,
        [s.business.id],
      );
      await db.query(
        `insert into private.external_calendar_sync (calendar_id)
       select id from public.external_calendars where business_id = $1`,
        [s.business.id],
      );

      const deps = getCalendarDeps();
      for (let run = 0; run < 3; run += 1) {
        await runCalendarJob(deps, { limit: 50, budgetMs: 100_000 });
      }

      expect(await eventIds(s)).toEqual(["h"]);
      const { rows } = await db.query<{
        provider_calendar_id: string;
        sync_status: string;
        failure_count: number;
        in_backoff: boolean;
      }>(
        `select c.provider_calendar_id, c.sync_status, s.failure_count,
              s.next_attempt_at > now() as in_backoff
       from public.external_calendars c
       join private.external_calendar_sync s on s.calendar_id = c.id
       where c.business_id = $1`,
        [s.business.id],
      );
      for (const row of rows) {
        if (row.provider_calendar_id === healthy) {
          expect(row.sync_status).toBe("synced");
        } else {
          // Attempted once, then waiting its backoff: not retried in a loop.
          expect(row).toMatchObject({
            sync_status: "error",
            failure_count: 1,
            in_backoff: true,
          });
        }
      }

      // The periodic job is global: 50 permanently failing calendars must
      // not stay due for the tests (or runs) that follow.
      await db.query(
        "delete from public.external_calendars where business_id = $1",
        [s.business.id],
      );
    },
  );
});

describe("channel renewal", () => {
  it("creates the new channel, catches up, then stops the former one: a change during the renewal is not lost", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    const former = (await currentChannel(calendarId))!.channel_id;
    await db.query(
      `update private.external_calendar_sync
       set channel_expires_at = now() + interval '1 hour' where calendar_id = $1`,
      [calendarId],
    );

    let busy: string | null = null;
    fake.hooks.push(async (url, method) => {
      if (
        method === "POST" &&
        url.pathname.endsWith("/events/watch") &&
        !busy
      ) {
        // A change, and a notification for it, while the channel is renewed.
        fake.putEvent(work(s), timed("during", D, "15:00", "16:00"));
        busy = await syncCalendar(getCalendarDeps(), calendarId);
      }
    });
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);

    expect(busy).toBe("busy");
    expect(await eventIds(s)).toEqual(["a", "during"]);
    const renewed = (await currentChannel(calendarId))!;
    expect(renewed.channel_id).not.toBe(former);
    expect(fake.channels.get(former)!.stopped).toBe(true);
    expect(fake.channels.get(renewed.channel_id)!.stopped).toBe(false);

    const index = (predicate: (url: URL, method: string) => boolean) =>
      fake.requests.findLastIndex((request) =>
        predicate(request.url, request.method),
      );
    const watch = index((url) => url.pathname.endsWith("/events/watch"));
    const stop = index((url) => url.pathname.endsWith("/channels/stop"));
    const firstCatchUp = fake.requests.findIndex(
      (request, position) =>
        position > watch && isEventsList(request.url, request.method),
    );
    expect(watch).toBeLessThan(firstCatchUp);
    expect(firstCatchUp).toBeLessThan(stop);
  });
});

describe("bounded incremental sync", () => {
  it(
    "more than 40 pages of changes switch to a full sync with a new generation",
    { timeout: 60_000 },
    async () => {
      const s = await setup();
      await connect(s);
      for (let i = 0; i < 45; i += 1)
        fake.putEvent(work(s), timed(`e${i}`, D, "09:00", "10:00"));
      await select(s, ["Travail"]);
      const calendarId = await blockingId(s);
      expect(await eventIds(s)).toHaveLength(45);

      fake.pageSize = 1;
      for (let i = 0; i < 42; i += 1) fake.deleteEvent(work(s), `e${i}`);
      const before = fake.requests.length;
      expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");

      const incremental = fake.requests
        .slice(before)
        .filter((request) => request.url.searchParams.has("syncToken"));
      expect(incremental).toHaveLength(40);
      expect(await eventIds(s)).toEqual(["e42", "e43", "e44"]);
      expect(await syncState(calendarId)).toMatchObject({
        generation: 2,
        sync_status: "synced",
      });
    },
  );
});

describe("free/busy-only calendars", () => {
  it("cannot be selected, and stop blocking when their access is reduced", async () => {
    const s = await setup();
    fake.setCalendars(s.account.sub, [
      {
        id: s.account.email,
        summary: "Personnel",
        timeZone: "UTC",
        primary: true,
      },
      { id: work(s), summary: "Travail", timeZone: "UTC" },
      {
        id: `team-${s.account.sub}`,
        summary: "Équipe",
        timeZone: "UTC",
        accessRole: "freeBusyReader",
      },
    ]);
    await connect(s);
    const listed = await calendarsOf(s);
    const team = listed.find((item) => item.name === "Équipe")!;
    expect(team.selectable).toBe(false);
    expect(listed.find((item) => item.name === "Travail")!.selectable).toBe(
      true,
    );
    expect(
      failed(await updateBlockingCalendarsAction({ calendarIds: [team.id] })),
    ).toBe("calendar_not_selectable");

    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    expect(await eventIds(s)).toEqual(["a"]);

    // Access reduced to free/busy at Google.
    fake.setCalendars(s.account.sub, [
      {
        id: s.account.email,
        summary: "Personnel",
        timeZone: "UTC",
        primary: true,
      },
      {
        id: work(s),
        summary: "Travail",
        timeZone: "UTC",
        accessRole: "freeBusyReader",
      },
    ]);
    sessionClient = s.owner.client;
    const refreshed = ok(await listConnectedCalendarsAction({ refresh: true }));
    expect(refreshed.find((item) => item.name === "Travail")).toMatchObject({
      blocking: false,
      selectable: false,
    });
    expect(await eventIds(s)).toEqual([]);
    expect(await slots(s)).toContain(`${D}T09:00:00.000Z`);
  });
});

describe("disconnect and reconnect races", () => {
  it("a reconnection is refused while the former grant is being revoked; allowed once it is done", async () => {
    const s = await setup();
    await connect(s);
    const B = otherAccount();
    const pendingConsent = await beginConnect(s, B);
    const formerRefresh = (await secretsRow(s))!.refresh_token_ciphertext;

    const held = fake.hold((url) => url.pathname === "/revoke");
    sessionClient = s.owner.client;
    const disconnecting = disconnectGoogleCalendarAction();
    await held.reached;

    expect((await connectionRow(s)).status).toBe("disconnected");
    expect((await connectionRow(s)).revocation_pending_until).not.toBeNull();
    sessionClient = s.owner.client;
    expect(failed(await startGoogleCalendarConnectAction())).toBe(
      "calendar_disconnect_in_progress",
    );
    expect(resultOf(await oauthCallback(callbackRequest(pendingConsent)))).toBe(
      "disconnect_in_progress",
    );
    expect((await connectionRow(s)).status).toBe("disconnected");

    held.release();
    ok(await disconnecting);
    expect((await connectionRow(s)).revocation_pending_until).toBeNull();
    expect(fake.revoked).toHaveLength(1);

    await connect(s, B);
    expect(await connectionRow(s)).toMatchObject({
      status: "active",
      provider_account_id: B.sub,
    });
    expect((await secretsRow(s))!.refresh_token_ciphertext).not.toBe(
      formerRefresh,
    );
    // B's grant was never revoked.
    await select(s, ["Travail B"]);
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
  });

  it("a disconnection of a former incarnation is a no-op", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    const stale = await admin.rpc("calendar_disconnect", {
      p_connection_id: connection.id,
      p_generation: randomUUID(),
    });
    expect(stale.data).toBeNull();
    expect((await connectionRow(s)).status).toBe("active");
    expect(await secretsRow(s)).toBeDefined();
  });
});

describe("manual conflicts", () => {
  it("use the appointment's occupied window, buffer included", async () => {
    const s = await setup({ buffer: 15 });
    await connect(s);
    fake.putEvent(work(s), timed("in-buffer", D, "11:05", "11:30"));
    fake.putEvent(work(s), timed("after-buffer", D, "11:15", "11:45"));
    await select(s, ["Travail"]);
    await createManualAppointment(
      s.owner.client,
      { businessId: s.business.id, timezone: "UTC" },
      {
        date: D,
        time: "10:00",
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
    sessionClient = s.owner.client;
    const conflicts = ok(
      await listCalendarConflictsAction({
        from: `${D}T00:00:00Z`,
        to: `${D2}T00:00:00Z`,
      }),
    );
    expect(conflicts.map((item) => item.eventStartsAt)).toEqual([
      `${D}T11:05:00.000Z`,
    ]);
  });
});

describe("encryption key rotation", () => {
  it("re-encrypts both secrets lazily under the new key; the former key can then be retired", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const formerKey = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY!;
    const newKey = randomBytes(32).toString("base64");
    try {
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = newKey;
      process.env.CALENDAR_TOKEN_PREVIOUS_KEYS = formerKey;
      expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
      const secrets = (await secretsRow(s))!;
      expect(secretKeyId(secrets.refresh_token_ciphertext)).toBe(
        secretKey(newKey).id,
      );
      expect(secretKeyId(secrets.access_token_ciphertext!)).toBe(
        secretKey(newKey).id,
      );

      delete process.env.CALENDAR_TOKEN_PREVIOUS_KEYS;
      await expireStoredAccessToken(s);
      expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
    } finally {
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = formerKey;
      delete process.env.CALENDAR_TOKEN_PREVIOUS_KEYS;
    }
  });
});

// ---------------------------------------------------------------------------
// Second hardening round (audit of 19b2191): CAS on secrets, revocation
// window, strict events, shared refresh deadline, orphan channels.
// ---------------------------------------------------------------------------

/** Reconnects in an open transaction (not committed): new incarnation. */
async function reconnectIn(
  transaction: OpenTransaction,
  s: Setup,
  account: { sub: string; email: string },
  secrets: { refresh: string; access: string },
) {
  await transaction.connection.query(
    `select public.calendar_save_connection($1, $2, 'google', $3, $4, $5::text[], $6, $7,
              now() + interval '1 hour', $8::jsonb)`,
    [
      s.business.id,
      s.owner.userId,
      account.sub,
      account.email,
      fake.grantedScopes,
      secrets.refresh,
      secrets.access,
      JSON.stringify([
        {
          id: account.email,
          name: "Personnel",
          timezone: "UTC",
          primary: true,
          accessRole: "owner",
        },
      ]),
    ],
  );
}

async function secretsState(s: Setup) {
  const { rows } = await db.query<{
    refresh_token_ciphertext: string;
    access_token_ciphertext: string | null;
    access_token_expires_at: Date | null;
    secret_version: string;
    credential_generation: string;
  }>(
    `select s.refresh_token_ciphertext, s.access_token_ciphertext, s.access_token_expires_at,
            s.secret_version, s.credential_generation
     from private.calendar_secrets s
     join public.calendar_connections c on c.id = s.connection_id
     where c.business_id = $1`,
    [s.business.id],
  );
  return rows[0]!;
}

const result = (query: Promise<{ rows: { result: unknown }[] }>) =>
  query.then((answer) => answer.rows[0]!.result);

describe("credential writes are compare-and-set (two real transactions)", () => {
  it("a stale writer waiting on a reconnection writes nothing: refresh, re-encryption, invalid_grant", async () => {
    const s = await setup();
    await connect(s);
    const writers: [
      string,
      (id: string, generation: string, version: string) => [string, unknown[]],
    ][] = [
      [
        "refresh",
        (id, generation) => [
          "select public.calendar_store_access_token($1, $2, 'stale-access', now() + interval '1 hour', 60000) = 'stored' as result",
          [id, generation],
        ],
      ],
      [
        "re-encryption",
        (id, generation, version) => [
          "select public.calendar_reencrypt_secrets($1, $2, $3, 'stale-refresh', 'stale-access') as result",
          [id, generation, version],
        ],
      ],
      [
        "invalid_grant",
        (id, generation) => [
          "select public.calendar_mark_reauth_required($1, $2, 'invalid_grant') as result",
          [id, generation],
        ],
      ],
    ];

    for (const [name, writer] of writers) {
      const connection = await connectionRow(s);
      const stale = await secretsState(s);

      // B reconnects (same account) and has not committed yet.
      const reconnection = await openTransaction();
      await reconnectIn(reconnection, s, s.account, {
        refresh: `refresh-b-${name}`,
        access: `access-b-${name}`,
      });

      // A, of the former incarnation, reaches its write and waits.
      const staleWriter = await openTransaction();
      const [sql, params] = writer(
        connection.id,
        connection.credential_generation,
        stale.secret_version,
      );
      const written = result(staleWriter.connection.query(sql, params));
      await waitUntilBlocked(staleWriter.pid);

      await closeTransaction(reconnection, "commit");
      expect(await written).toBe(false);
      await closeTransaction(staleWriter, "commit");

      expect(await secretsState(s)).toMatchObject({
        refresh_token_ciphertext: `refresh-b-${name}`,
        access_token_ciphertext: `access-b-${name}`,
      });
      expect((await connectionRow(s)).status).toBe("active");
    }
  });

  it("a writer that locked first finishes, then the reconnection replaces everything (no deadlock)", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);

    const writer = await openTransaction();
    expect(
      await result(
        writer.connection.query(
          "select public.calendar_store_access_token($1, $2, 'first-access', now() + interval '1 hour', 60000) = 'stored' as result",
          [connection.id, connection.credential_generation],
        ),
      ),
    ).toBe(true);

    const reconnection = await openTransaction();
    const reconnected = reconnectIn(reconnection, s, s.account, {
      refresh: "refresh-b",
      access: "access-b",
    });
    await waitUntilBlocked(reconnection.pid);
    await closeTransaction(writer, "commit");
    await reconnected;
    await closeTransaction(reconnection, "commit");

    const secrets = await secretsState(s);
    expect(secrets).toMatchObject({
      refresh_token_ciphertext: "refresh-b",
      access_token_ciphertext: "access-b",
    });
    expect(secrets.credential_generation).toBe(
      (await connectionRow(s)).credential_generation,
    );
  });

  it("a re-encryption never replaces a token refreshed meanwhile (both orders)", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    const read = await secretsState(s);
    const refreshedUntil = "2030-01-01T00:00:00.000Z";

    // The refresh holds the row; the re-encryption of what was read waits.
    const refresh = await openTransaction();
    await refresh.connection.query(
      "select public.calendar_store_access_token($1, $2, 'refreshed', $3::timestamptz, 60000)",
      [connection.id, connection.credential_generation, refreshedUntil],
    );
    const reencryption = await openTransaction();
    const reencrypted = result(
      reencryption.connection.query(
        "select public.calendar_reencrypt_secrets($1, $2, $3, 'reencrypted-refresh', 'reencrypted-old-access') as result",
        [connection.id, connection.credential_generation, read.secret_version],
      ),
    );
    await waitUntilBlocked(reencryption.pid);
    await closeTransaction(refresh, "commit");
    expect(await reencrypted).toBe(false);
    await closeTransaction(reencryption, "commit");
    let secrets = await secretsState(s);
    expect(secrets.access_token_ciphertext).toBe("refreshed");
    expect(secrets.access_token_expires_at!.toISOString()).toBe(refreshedUntil);

    // The re-encryption holds the row; the refresh waits, then wins.
    const reencryption2 = await openTransaction();
    expect(
      await result(
        reencryption2.connection.query(
          "select public.calendar_reencrypt_secrets($1, $2, $3, 'reencrypted-refresh', 'reencrypted-access') as result",
          [
            connection.id,
            connection.credential_generation,
            secrets.secret_version,
          ],
        ),
      ),
    ).toBe(true);
    const refresh2 = await openTransaction();
    const refreshed = result(
      refresh2.connection.query(
        "select public.calendar_store_access_token($1, $2, 'refreshed-2', '2031-01-01T00:00:00Z'::timestamptz, 60000) = 'stored' as result",
        [connection.id, connection.credential_generation],
      ),
    );
    await waitUntilBlocked(refresh2.pid);
    await closeTransaction(reencryption2, "commit");
    expect(await refreshed).toBe(true);
    await closeTransaction(refresh2, "commit");
    secrets = await secretsState(s);
    expect(secrets.access_token_ciphertext).toBe("refreshed-2");
    expect(secrets.refresh_token_ciphertext).toBe("reencrypted-refresh");
    expect(secrets.access_token_expires_at!.toISOString()).toBe(
      "2031-01-01T00:00:00.000Z",
    );
  });

  it("key rotation: a refresh landing during the lazy re-encryption keeps its token and expiry (server code)", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const formerKey = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY!;
    const newKey = randomBytes(32).toString("base64");
    const aad = `calendar-token:google:${s.business.id}`;
    const refreshedUntil = new Date(Date.now() + 3_000_000);
    try {
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = newKey;
      process.env.CALENDAR_TOKEN_PREVIOUS_KEYS = formerKey;
      // The refresh commits between the read and the re-encryption.
      rpcHooks.set("calendar_reencrypt_secrets", {
        before: async () => {
          rpcHooks.delete("calendar_reencrypt_secrets");
          const connection = await connectionRow(s);
          await admin.rpc("calendar_store_access_token", {
            p_connection_id: connection.id,
            p_generation: connection.credential_generation,
            p_access_token_ciphertext: encryptSecret(
              "at-refreshed",
              aad,
              secretKey(newKey),
            ),
            p_access_token_expires_at: refreshedUntil.toISOString(),
            p_remaining_ms: 60_000,
          });
        },
      });
      expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);

      const secrets = await secretsState(s);
      expect(
        decryptSecret(secrets.access_token_ciphertext!, aad, [
          secretKey(newKey),
        ]),
      ).toBe("at-refreshed");
      expect(secrets.access_token_expires_at!.toISOString()).toBe(
        refreshedUntil.toISOString(),
      );
    } finally {
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = formerKey;
      delete process.env.CALENDAR_TOKEN_PREVIOUS_KEYS;
    }
  });
});

describe("shared token refresh", () => {
  it("a worker stops waiting at its own deadline; the shared refresh goes on for the others", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    const connection = await connectionRow(s);
    await expireStoredAccessToken(s);
    const refreshes = () =>
      fake.count(
        (url, method) => url.pathname === "/token" && method === "POST",
      );
    const before = refreshes();

    const held = fake.hold(
      (url, method) => url.pathname === "/token" && method === "POST",
    );
    const started = Date.now();
    const worker = syncCalendar(getCalendarDeps(), calendarId, {
      budgetMs: 1500,
    });
    await held.reached;
    // Another caller joins the same refresh, without a deadline.
    const other = getAccessToken(getCalendarDeps(), connection.id);

    expect(await worker).toBe("stale");
    expect(Date.now() - started).toBeLessThan(3500);

    held.release();
    expect(await other).toMatch(/^at-/);
    expect(refreshes() - before).toBe(1);
  });
});

describe("remote revocation window", () => {
  async function disconnectAnsweredLate(
    s: Setup,
    meanwhile: () => Promise<void>,
  ) {
    rpcHooks.set("calendar_disconnect", {
      after: async () => {
        rpcHooks.delete("calendar_disconnect");
        // Three minutes pass before the answer reaches the server code.
        await db.query(
          `update public.calendar_connections
           set revocation_authorized_until = now() - interval '2 minutes',
               revocation_pending_until = now() - interval '1 minute'
           where business_id = $1`,
          [s.business.id],
        );
        await meanwhile();
      },
    });
    sessionClient = s.owner.client;
    ok(await disconnectGoogleCalendarAction());
  }

  const remoteCalls = () =>
    fake.count(
      (url) =>
        url.pathname === "/revoke" || url.pathname.endsWith("/channels/stop"),
    );

  it("same account reconnected while the disconnection answer was delayed 3 min: no revocation", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    await disconnectAnsweredLate(s, () => connect(s));

    expect(remoteCalls()).toBe(0);
    expect(fake.revoked).toEqual([]);
    expect(await connectionRow(s)).toMatchObject({
      status: "active",
      provider_account_id: s.account.sub,
    });
    await select(s, ["Travail"]);
    expect(Object.values((await syncNow(s)).outcomes)).toEqual(["synced"]);
  });

  it("another account reconnected meanwhile: no revocation either", async () => {
    const s = await setup();
    await connect(s);
    const B = otherAccount();
    await disconnectAnsweredLate(s, () => connect(s, B));

    expect(remoteCalls()).toBe(0);
    expect(await connectionRow(s)).toMatchObject({
      status: "active",
      provider_account_id: B.sub,
    });
  });

  it("nobody reconnected but the window fixed at the disconnection closed: no revocation", async () => {
    const s = await setup();
    await connect(s);
    await disconnectAnsweredLate(s, async () => undefined);
    expect(remoteCalls()).toBe(0);
    expect((await connectionRow(s)).status).toBe("disconnected");
  });

  it("within the window, the revocation runs and is bounded by it", async () => {
    const s = await setup();
    await connect(s);
    sessionClient = s.owner.client;
    ok(await disconnectGoogleCalendarAction());
    expect(fake.revoked).toHaveLength(1);
    const { rows } = await db.query(
      "select revocation_authorized_until, revocation_pending_until from public.calendar_connections where business_id = $1",
      [s.business.id],
    );
    expect(rows[0]).toEqual({
      revocation_authorized_until: null,
      revocation_pending_until: null,
    });
  });
});

describe("orphan channel cleanup", () => {
  it("a channel created just before a reconnection is stopped with the credentials that created it", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    await db.query(
      `update private.external_calendar_sync
       set channel_expires_at = now() + interval '1 hour' where calendar_id = $1`,
      [calendarId],
    );
    const known = new Set(fake.channels.keys());

    const held = fake.hold(
      (url, method) =>
        method === "POST" && url.pathname.endsWith("/events/watch"),
    );
    const worker = syncCalendar(getCalendarDeps(), calendarId);
    await held.reached;
    await connect(s, otherAccount());
    held.release();
    expect(await worker).toBe("superseded");

    const created = [...fake.channels.keys()].filter((id) => !known.has(id));
    expect(created).toHaveLength(1);
    expect(fake.channels.get(created[0]!)!.stopped).toBe(true);
  });
});

describe("strict events: semantically invalid events fail the page", () => {
  it("one invalid event among 249 valid ones: nothing applied, nothing deleted, cursor kept", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    const before = await syncState(calendarId);

    const items: unknown[] = Array.from({ length: 249 }, (_, index) => ({
      id: `new-${index}`,
      status: "confirmed",
      start: { dateTime: at(D2, "10:00") },
      end: { dateTime: at(D2, "11:00") },
    }));
    items.splice(200, 0, {
      id: "a",
      status: "confirmed",
      start: { dateTime: at(D, "10:00") },
      end: { dateTime: at(D, "09:00") },
    });
    fake.failNext((url) => url.pathname.endsWith("/events"), 200, 1, {
      items,
      nextSyncToken: "sync-999",
    });
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("error");
    expect(await eventIds(s)).toEqual(["a"]);
    expect(await syncState(calendarId)).toMatchObject({
      sync_status: "error",
      last_error: "provider_protocol",
      sync_token: before.sync_token,
      generation: before.generation,
    });
    expect(await slots(s)).not.toContain(`${D}T09:00:00.000Z`);
  });
});

describe("activation of a blocking calendar", () => {
  it("protects only after its first complete sync", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    fake.failNext((url) => url.pathname.endsWith("/events"), 403, 1, {
      error: { errors: [{ reason: "forbidden" }] },
    });
    await select(s, ["Travail"]);
    let calendar = (await calendarsOf(s)).find((item) => item.blocking)!;
    expect(calendar).toMatchObject({
      blocking: true,
      protecting: false,
      syncStatus: "error",
    });

    await db.query(
      "update private.external_calendar_sync set next_attempt_at = null where calendar_id = $1",
      [calendar.id],
    );
    expect(await syncCalendar(getCalendarDeps(), calendar.id)).toBe("synced");
    calendar = (await calendarsOf(s)).find((item) => item.id === calendar.id)!;
    expect(calendar).toMatchObject({ protecting: true, syncStatus: "synced" });

    sessionClient = s.owner.client;
    ok(await updateBlockingCalendarsAction({ calendarIds: [] }));
    expect(
      (await calendarsOf(s)).find((item) => item.id === calendar.id),
    ).toMatchObject({ blocking: false, protecting: false, lastSyncedAt: null });
  });
});

// ---------------------------------------------------------------------------
// Third hardening round (audit of d560094): no business-zone fallback,
// strict zones, bounded refresh, best-effort remote disconnection.
// ---------------------------------------------------------------------------

describe("calendars without a zone of their own", () => {
  it("cannot become blocking; existing availability is untouched", async () => {
    const s = await setup();
    fake.setCalendars(s.account.sub, [
      {
        id: s.account.email,
        summary: "Personnel",
        timeZone: "UTC",
        primary: true,
      },
      { id: work(s), summary: "Travail", timeZone: "UTC" },
      {
        id: `nozone-${s.account.sub}`,
        summary: "Sans fuseau",
        timeZone: undefined as unknown as string,
      },
    ]);
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    const before = await slots(s);

    const listed = await calendarsOf(s);
    const noZone = listed.find((item) => item.name === "Sans fuseau")!;
    expect(noZone).toMatchObject({ timezone: null, selectable: false });
    sessionClient = s.owner.client;
    expect(
      failed(
        await updateBlockingCalendarsAction({
          calendarIds: [
            noZone.id,
            ...listed.filter((c) => c.blocking).map((c) => c.id),
          ],
        }),
      ),
    ).toBe("calendar_not_selectable");
    expect(await eventIds(s)).toEqual(["a"]);
    expect(await slots(s)).toEqual(before);
  });
});

describe("strict zones end to end", () => {
  it("one event with an unknown zone among 249 valid ones: applied widened, nothing dropped or narrowed", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), {
      id: "x",
      start: { dateTime: `${D}T09:00:00`, timeZone: "Europe/Paris" },
      end: { dateTime: `${D}T10:00:00`, timeZone: "Europe/Paris" },
    });
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    const [cached] = await storedEvents(s);

    const items: unknown[] = Array.from({ length: 249 }, (_, index) => ({
      id: `new-${index}`,
      start: { dateTime: at(D2, "10:00") },
      end: { dateTime: at(D2, "11:00") },
    }));
    items.splice(100, 0, {
      id: "x",
      start: { dateTime: `${D}T09:00:00`, timeZone: "Europe/Pariss" },
      end: { dateTime: `${D}T10:00:00`, timeZone: "Europe/Pariss" },
    });
    fake.failNext((url) => url.pathname.endsWith("/events"), 200, 1, {
      items,
      nextSyncToken: "sync-999",
      timeZone: "UTC",
    });
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");

    const stored = await storedEvents(s);
    expect(stored).toHaveLength(250);
    const x = stored.find((row) => row.provider_event_id === "x")!;
    // Widened to every zone: contains the former exact period.
    expect(x.starts_at.getTime()).toBeLessThanOrEqual(
      cached!.starts_at.getTime(),
    );
    expect(x.ends_at.getTime()).toBeGreaterThanOrEqual(
      cached!.ends_at.getTime(),
    );
    expect([x.starts_at.toISOString(), x.ends_at.toISOString()]).toEqual([
      new Date(Date.parse(`${D}T09:00:00Z`) - 14 * 3_600_000).toISOString(),
      new Date(Date.parse(`${D}T10:00:00Z`) + 12 * 3_600_000).toISOString(),
    ]);
  });
});

describe("token refresh budget", () => {
  async function holdConnectionRow(s: Setup) {
    const holder = await openTransaction();
    await holder.connection.query(
      "select 1 from public.calendar_connections where business_id = $1 for update",
      [s.business.id],
    );
    return holder;
  }

  it("reading the credentials is bounded by the caller's deadline (re-encryption blocked)", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    const formerKey = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY!;
    const holder = await holdConnectionRow(s);
    try {
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY =
        randomBytes(32).toString("base64");
      process.env.CALENDAR_TOKEN_PREVIOUS_KEYS = formerKey;

      let started = Date.now();
      await expect(
        getAccessToken(getCalendarDeps(), connection.id, {
          deadline: Date.now() + 1000,
        }),
      ).rejects.toMatchObject({ kind: "unavailable" });
      expect(Date.now() - started).toBeLessThan(2000);

      // Without a deadline, the blocked re-encryption gives up (lock
      // timeout) and the read still answers with the stored token.
      started = Date.now();
      expect(await getAccessToken(getCalendarDeps(), connection.id)).toMatch(
        /^at-/,
      );
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      await closeTransaction(holder, "rollback");
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = formerKey;
      delete process.env.CALENDAR_TOKEN_PREVIOUS_KEYS;
    }
  });

  it("a blocked write: the caller leaves at its deadline, the shared refresh ends, nothing late is written, a new refresh works", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    await expireStoredAccessToken(s);
    const stale = await secretsState(s);
    const refreshes = () =>
      fake.count(
        (url, method) => url.pathname === "/token" && method === "POST",
      );
    const before = refreshes();

    const holder = await holdConnectionRow(s);
    let started = Date.now();
    await expect(
      getAccessToken(getCalendarDeps(), connection.id, {
        deadline: Date.now() + 1000,
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(refreshes() - before).toBe(1);

    // The shared refresh itself ends (lock timeout): a caller without a
    // deadline that joins it gets its failure, not an endless wait.
    started = Date.now();
    await expect(
      getAccessToken(getCalendarDeps(), connection.id),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(6000);
    await closeTransaction(holder, "rollback");

    // Nothing was written late.
    expect(await secretsState(s)).toMatchObject({
      access_token_ciphertext: stale.access_token_ciphertext,
      secret_version: stale.secret_version,
    });
    // The single-flight entry is gone: a new refresh starts and stores.
    expect(await getAccessToken(getCalendarDeps(), connection.id)).toMatch(
      /^at-/,
    );
    expect(refreshes() - before).toBeGreaterThanOrEqual(2);
    expect((await secretsState(s)).access_token_ciphertext).not.toBe(
      stale.access_token_ciphertext,
    );
  });
});

describe("a committed disconnection is a success", () => {
  async function disconnected(s: Setup) {
    sessionClient = s.owner.client;
    ok(await disconnectGoogleCalendarAction());
    expect((await connectionRow(s)).status).toBe("disconnected");
    expect(await secretsState(s).catch(() => undefined)).toBeUndefined();
    expect(await storedEvents(s)).toEqual([]);
    expect(await providerCalendarIds(s)).toEqual([]);
  }

  it("even when preparing the remote revocation fails", async () => {
    const s = await setup();
    await connect(s);
    fake.putEvent(work(s), timed("a", D, "09:00", "10:00"));
    await select(s, ["Travail"]);
    rpcHooks.set("calendar_begin_revocation", {
      before: async () => {
        throw new Error("database unavailable");
      },
    });
    await disconnected(s);
    expect(fake.revoked).toEqual([]);
  });

  it("even when stopping channels and revoking fail at Google", async () => {
    const s = await setup();
    await connect(s);
    await select(s, ["Travail"]);
    fake.failNext((url) => url.pathname.endsWith("/channels/stop"), 403, 5, {
      error: { errors: [{ reason: "forbidden" }] },
    });
    fake.failNext((url) => url.pathname === "/revoke", 500, 10);
    await disconnected(s);
  });

  it("even when marking the revocation done fails", async () => {
    const s = await setup();
    await connect(s);
    rpcHooks.set("calendar_revocation_done", {
      before: async () => {
        throw new Error("database unavailable");
      },
    });
    await disconnected(s);
    expect(fake.revoked).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fourth round (audit of 6e2743c): zone trust, write deadline on the
// database clock, cancellation of database calls.
// ---------------------------------------------------------------------------

describe("trust in a calendar's zone, end to end", () => {
  it("an untrusted calendar keeps syncing with a margin, shows it, and the periodic job restores it", async () => {
    const s = await setup();
    fake.setCalendars(s.account.sub, [
      {
        id: s.account.email,
        summary: "Personnel",
        timeZone: "UTC",
        primary: true,
      },
      { id: work(s), summary: "Travail", timeZone: "Europe/Paris" },
    ]);
    await connect(s);
    fake.putEvent(work(s), {
      id: "day",
      start: { date: D },
      end: { date: D2 },
    });
    await select(s, ["Travail"]);
    const calendarId = await blockingId(s);
    const exactDay = await storedEvents(s);

    // Google reports a zone our tzdata does not know (e.g. a recent one).
    fake.setTimeZone(work(s), "America/Ciudad_Juarezz");
    sessionClient = s.owner.client;
    ok(await listConnectedCalendarsAction({ refresh: true }));
    await flush();

    // Still synced: a new timed event blocks exactly, a new all-day event
    // over every zone, and the calendar shows it is not exact.
    fake.putEvent(work(s), timed("meeting", D2, "10:00", "11:00"));
    fake.putEvent(work(s), {
      id: "off",
      start: { date: D2 },
      end: { date: dateInDays(12) },
    });
    expect(await syncCalendar(getCalendarDeps(), calendarId)).toBe("synced");
    const rows = Object.fromEntries(
      (await storedEvents(s)).map((row) => [
        row.provider_event_id,
        [row.starts_at.toISOString(), row.ends_at.toISOString()],
      ]),
    );
    expect(rows.meeting).toEqual([
      new Date(at(D2, "10:00")).toISOString(),
      new Date(at(D2, "11:00")).toISOString(),
    ]);
    const wide = (date: string, hours: number) =>
      new Date(
        Date.parse(`${date}T00:00:00Z`) + hours * 3_600_000,
      ).toISOString();
    expect(rows.off).toEqual([wide(D2, -14), wide(dateInDays(12), 12)]);
    expect(rows.day).toEqual([wide(D, -14), wide(D2, 12)]);

    const shown = (await calendarsOf(s)).find(
      (item) => item.id === calendarId,
    )!;
    expect(shown).toMatchObject({
      timezoneTrusted: false,
      syncStatus: "degraded",
      lastError: "untrusted_timezone",
    });
    expect(describeSyncStatus(shown)).toMatchObject({
      label: "Synchronisé avec une marge : fuseau horaire non reconnu",
      healthy: false,
    });

    // The periodic job reads the calendar list again (at most every 6 h):
    // a known zone restores trust, exact projection, full sync, synced.
    fake.setTimeZone(work(s), "Europe/Paris");
    const lists = () =>
      fake.count((url) => url.pathname.endsWith("/calendarList"));
    let before = lists();
    await runCalendarJob(getCalendarDeps(), { limit: 500, budgetMs: 100_000 });
    expect(lists()).toBe(before); // read less than 6 h ago: not again
    await db.query(
      "update public.calendar_connections set calendar_list_checked_at = now() - interval '7 hours' where business_id = $1",
      [s.business.id],
    );
    before = lists();
    await runCalendarJob(getCalendarDeps(), { limit: 500, budgetMs: 100_000 });
    expect(lists()).toBe(before + 1);

    expect(
      (await calendarsOf(s)).find((item) => item.id === calendarId),
    ).toMatchObject({
      timezoneTrusted: true,
      syncStatus: "synced",
    });
    const restored = await storedEvents(s);
    expect(restored.find((row) => row.provider_event_id === "day")).toEqual(
      exactDay.find((row) => row.provider_event_id === "day"),
    );
  });
});

describe("refreshed token written only before the deadline", () => {
  it("SQL: a write whose deadline passes while it waits for the secrets row changes nothing (two real transactions)", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    const before = await secretsState(s);

    const holder = await openTransaction();
    await holder.connection.query(
      "select 1 from private.calendar_secrets where connection_id = $1 for update",
      [connection.id],
    );
    const writer = await openTransaction();
    const written = result(
      writer.connection.query(
        "select public.calendar_store_access_token($1, $2, 'late-access', now() + interval '1 hour', 500) as result",
        [connection.id, connection.credential_generation],
      ),
    );
    await waitUntilBlocked(writer.pid);
    // Released well after the 0.5 s deadline (minus its margin).
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await closeTransaction(holder, "rollback");

    expect(await written).toBe("expired");
    await closeTransaction(writer, "commit");
    expect(await secretsState(s)).toEqual(before);
  });

  it("server code: the shared refresh ends at its budget, nothing is written later, a new refresh works", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    await expireStoredAccessToken(s);
    const before = await secretsState(s);
    const deps = { ...getCalendarDeps(), refreshBudgetMs: 800 };

    const holder = await openTransaction();
    await holder.connection.query(
      "select 1 from private.calendar_secrets where connection_id = $1 for update",
      [connection.id],
    );
    const started = Date.now();
    await expect(getAccessToken(deps, connection.id)).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(Date.now() - started).toBeLessThan(1800);

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await closeTransaction(holder, "rollback");
    // Let the abandoned write reach its decision.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await secretsState(s)).toEqual(before);

    // The single-flight entry is gone: a new refresh starts and stores.
    expect(await getAccessToken(getCalendarDeps(), connection.id)).toMatch(
      /^at-/,
    );
    expect(Number((await secretsState(s)).secret_version)).toBeGreaterThan(
      Number(before.secret_version),
    );
  });
});

describe("database calls under a deadline", () => {
  it("never starts a call whose deadline already passed", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    rpcCalls.length = 0;
    await expect(
      getAccessToken(getCalendarDeps(), connection.id, {
        deadline: Date.now() - 1,
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(rpcCalls.map((call) => call.name)).not.toContain(
      "calendar_read_secrets",
    );
  });

  it("aborts a call that outlives its deadline; its late outcome is consumed (no unhandled rejection)", async () => {
    const s = await setup();
    await connect(s);
    const connection = await connectionRow(s);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);

    const blocker = await openTransaction();
    await blocker.connection.query(
      "lock table private.calendar_secrets in access exclusive mode",
    );
    try {
      rpcCalls.length = 0;
      const started = Date.now();
      await expect(
        getAccessToken(getCalendarDeps(), connection.id, {
          deadline: Date.now() + 500,
        }),
      ).rejects.toMatchObject({ kind: "unavailable" });
      expect(Date.now() - started).toBeLessThan(1500);
      const read = rpcCalls.find(
        (call) => call.name === "calendar_read_secrets",
      );
      expect(read?.signal?.aborted).toBe(true);
    } finally {
      await closeTransaction(blocker, "rollback");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    process.off("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
  });
});
