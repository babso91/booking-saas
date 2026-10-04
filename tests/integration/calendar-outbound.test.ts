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
  disconnectGoogleCalendarAction,
  enableCalendarOutboundAction,
  getCalendarIntegrationStatusAction,
  getCalendarOutboundStatusAction,
  listConnectedCalendarsAction,
  reactivateCalendarOutboundAction,
  retryCalendarOutboundAction,
  startGoogleCalendarConnectAction,
  startGoogleCalendarWriteAuthorizationAction,
  syncGoogleCalendarNowAction,
  updateBlockingCalendarsAction,
} from "@/features/calendar/actions/calendar";
import {
  createManualAppointment,
  setAppointmentStatus,
  updateAppointment,
} from "@/features/agenda/data/appointments";
import { getCalendarDeps } from "@/features/calendar/data/deps";
import {
  ensureOutboundCalendar,
  processOutbound,
} from "@/features/calendar/data/outbound";
import type { ActionResult } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import { FakeGoogle, WRITE_SCOPE } from "../support/fake-google";
import {
  createBusiness,
  createProfessional,
  createService,
  dateInDays,
  db,
  env,
  everyDay,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Outbound: Booking appointments mirrored to a dedicated Google calendar
// created by the app. Google is the in-memory FakeGoogle reached through the
// real adapter; Server Actions, the OAuth callback, SQL functions, triggers
// and RLS are real. Workers are run explicitly (processOutbound), as the
// background kick and the periodic job would.

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

function failed<T>(result: ActionResult<T>) {
  if (result.ok) throw new Error("Expected a failure");
  return result.error.code;
}

const D = dateInDays(10);
const at = (date: string, time: string) => `${date}T${time}:00.000Z`;

type Account = { sub: string; email: string };
type Setup = {
  owner: Professional;
  business: TestBusiness;
  name: string;
  service: string;
  account: Account;
};

function newAccount(): Account {
  return {
    sub: `sub-${randomUUID()}`,
    email: `${randomUUID().slice(0, 6)}@gmail.test`,
  };
}

function givePersonalCalendars(account: Account) {
  fake.setCalendars(account.sub, [
    { id: account.email, summary: "Personnel", timeZone: "UTC", primary: true },
    { id: `work-${account.sub}`, summary: "Travail", timeZone: "UTC" },
  ]);
}

async function setup(options: { buffer?: number } = {}): Promise<Setup> {
  const owner = await createProfessional("outbound");
  const name = `Studio ${randomUUID().slice(0, 6)}`;
  const business = await createBusiness(owner.userId, {
    name,
    timezone: "UTC",
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: options.buffer ?? 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
    },
  });
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
  const service = await createService(business.id, {
    name: "Coupe",
    durationMinutes: 60,
  });
  const account = newAccount();
  givePersonalCalendars(account);
  return { owner, business, name, service, account };
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

/** The write authorization, answered by `account`. Background kept. */
async function authorizeWrite(s: Setup, account = s.account) {
  sessionClient = s.owner.client;
  const { authorizationUrl } = ok(
    await startGoogleCalendarWriteAuthorizationAction(),
  );
  const { code, state } = fake.authorize(account, authorizationUrl);
  return resultOf(await oauthCallback(callbackRequest({ state, code })));
}

/** Connected, write authorized, dedicated calendar created. */
async function enabled(s: Setup) {
  await connect(s);
  expect(await authorizeWrite(s)).toBe("write_authorized");
  await flush();
  const [calendar] = fake.appCalendars(s.account.sub);
  expect(calendar).toBeDefined();
  return calendar!.id;
}

const run = (s: Setup) =>
  processOutbound(getCalendarDeps(), { businessId: s.business.id });

async function status(s: Setup) {
  sessionClient = s.owner.client;
  return ok(await getCalendarOutboundStatusAction());
}

async function outboundRow(s: Setup) {
  const { rows } = await db.query(
    "select * from private.calendar_outbound where business_id = $1",
    [s.business.id],
  );
  return rows[0] as
    | {
        status: string;
        generation: string;
        provider_calendar_id: string | null;
        action_code: string | null;
        calendar_marker: string;
      }
    | undefined;
}

async function mirror(appointmentId: string) {
  const { rows } = await db.query(
    "select * from private.appointment_calendar_mirrors where appointment_id = $1",
    [appointmentId],
  );
  return rows[0] as
    | {
        desired_revision: string;
        applied_revision: string;
        attempts: number;
        provider_calendar_id: string | null;
        event_id: string;
        last_error: string | null;
      }
    | undefined;
}

async function createAppointment(s: Setup, time: string, firstName = "Léa") {
  const created = await createManualAppointment(
    s.owner.client,
    { businessId: s.business.id, timezone: "UTC" },
    {
      date: D,
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
    "select id, status, starts_at, ends_at, version, client_id from public.appointments where id = $1",
    [id],
  );
  return rows[0] as {
    id: string;
    status: string;
    starts_at: Date;
    ends_at: Date;
    version: number;
    client_id: string;
  };
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

async function changeStatus(
  s: Setup,
  id: string,
  next: "cancelled" | "completed" | "no_show" | "confirmed",
) {
  const row = await appointmentRow(id);
  await setAppointmentStatus(
    s.owner.client,
    { businessId: s.business.id, timezone: "UTC" },
    {
      appointmentId: id,
      expectedVersion: row.version,
      status: next,
      cancellationReason: next === "cancelled" ? "Annulé" : null,
    },
  );
}

const eventIdOf = (appointmentId: string) =>
  `bk${appointmentId.replace(/-/g, "")}`;

const googleWrites = () =>
  fake.count(
    (url, method) =>
      url.pathname.startsWith("/calendar/v3/calendars") && method !== "GET",
  );

const providerCalls = () =>
  fake.count((url) => url.host === "www.googleapis.com");

const isInsert = (url: URL, method: string) =>
  method === "POST" && /\/events$/.test(url.pathname);

function liveEvents(calendarId: string) {
  return fake
    .storedEvents(calendarId)
    .filter((event) => event.status !== "cancelled");
}

describe("write authorization (incremental, same account)", () => {
  it("adds calendar.app.created to the connected account: inbound selection, sync state and incarnation untouched", async () => {
    const s = await setup();
    await connect(s);
    sessionClient = s.owner.client;
    const calendars = ok(await listConnectedCalendarsAction());
    ok(
      await updateBlockingCalendarsAction({
        calendarIds: calendars
          .filter((calendar) => calendar.name === "Travail")
          .map((calendar) => calendar.id),
      }),
    );
    await flush();
    const before = await db.query(
      `select c.credential_generation, s.refresh_token_ciphertext,
              (select json_agg(json_build_object('id', e.id, 'blocking', e.selected_for_blocking, 'status', e.sync_status) order by e.id)
                 from public.external_calendars e where e.connection_id = c.id) as calendars
       from public.calendar_connections c join private.calendar_secrets s on s.connection_id = c.id
       where c.business_id = $1`,
      [s.business.id],
    );

    sessionClient = s.owner.client;
    const { authorizationUrl } = ok(
      await startGoogleCalendarWriteAuthorizationAction(),
    );
    const url = new URL(authorizationUrl);
    // Only the new scope (and openid, to prove the account), on top of the
    // scopes granted before; the connected account is hinted.
    expect(url.searchParams.get("scope")).toBe(`openid ${WRITE_SCOPE}`);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("login_hint")).toBe(s.account.sub);

    const { code, state } = fake.authorize(s.account, authorizationUrl);
    expect(
      resultOf(await oauthCallback(callbackRequest({ state, code }))),
    ).toBe("write_authorized");

    const after = await db.query(
      `select c.credential_generation, c.scopes, s.refresh_token_ciphertext,
              (select json_agg(json_build_object('id', e.id, 'blocking', e.selected_for_blocking, 'status', e.sync_status) order by e.id)
                 from public.external_calendars e where e.connection_id = c.id) as calendars
       from public.calendar_connections c join private.calendar_secrets s on s.connection_id = c.id
       where c.business_id = $1`,
      [s.business.id],
    );
    expect(after.rows[0].credential_generation).toBe(
      before.rows[0].credential_generation,
    );
    expect(after.rows[0].calendars).toEqual(before.rows[0].calendars);
    expect(after.rows[0].scopes).toEqual(
      expect.arrayContaining([
        WRITE_SCOPE,
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      ]),
    );
    // A new refresh token (combined grant) replaced the former one.
    expect(after.rows[0].refresh_token_ciphertext).not.toBe(
      before.rows[0].refresh_token_ciphertext,
    );
    expect(await status(s)).toMatchObject({
      writeAuthorized: true,
      enabled: true,
      state: "creating",
      health: "pending",
    });
  });

  it("keeps the stored refresh token when Google sends none", async () => {
    const s = await setup();
    await connect(s);
    const { rows: before } = await db.query(
      "select s.refresh_token_ciphertext from private.calendar_secrets s join public.calendar_connections c on c.id = s.connection_id where c.business_id = $1",
      [s.business.id],
    );
    fake.sendRefreshToken = false;
    expect(await authorizeWrite(s)).toBe("write_authorized");
    const { rows: after } = await db.query(
      "select s.refresh_token_ciphertext from private.calendar_secrets s join public.calendar_connections c on c.id = s.connection_id where c.business_id = $1",
      [s.business.id],
    );
    expect(after[0].refresh_token_ciphertext).toBe(
      before[0].refresh_token_ciphertext,
    );
    expect((await status(s)).writeAuthorized).toBe(true);
  });

  it("account A connected, Google answers with account B: refused, nothing of B stored, A unchanged and still working", async () => {
    const s = await setup();
    await connect(s);
    const other = newAccount();
    givePersonalCalendars(other);
    const snapshot = async () =>
      (
        await db.query(
          `select c.provider_account_id, c.account_email, c.status, c.scopes,
                  c.credential_generation, s.refresh_token_ciphertext,
                  s.access_token_ciphertext, s.secret_version,
                  (select json_agg(e.provider_calendar_id order by e.provider_calendar_id)
                     from public.external_calendars e where e.connection_id = c.id) as calendars
           from public.calendar_connections c join private.calendar_secrets s on s.connection_id = c.id
           where c.business_id = $1`,
          [s.business.id],
        )
      ).rows[0];
    const before = await snapshot();

    expect(await authorizeWrite(s, other)).toBe("account_mismatch");
    await flush();

    expect(await snapshot()).toEqual(before);
    expect(await outboundRow(s)).toBeUndefined();
    expect(fake.appCalendars(other.sub)).toHaveLength(0);
    expect(fake.appCalendars(s.account.sub)).toHaveLength(0);
    // A still works: its calendar list is read with A's credentials.
    sessionClient = s.owner.client;
    const calendars = ok(await listConnectedCalendarsAction({ refresh: true }));
    expect(calendars.map((calendar) => calendar.name).sort()).toEqual([
      "Personnel",
      "Travail",
    ]);
    expect((await status(s)).writeAuthorized).toBe(false);
  });

  it("without the write scope, enabling returns the consent URL instead", async () => {
    const s = await setup();
    await connect(s);
    sessionClient = s.owner.client;
    const result = ok(await enableCalendarOutboundAction());
    expect(result.authorizationUrl).toContain(encodeURIComponent(WRITE_SCOPE));
    expect(result.status).toMatchObject({
      writeAuthorized: false,
      enabled: false,
      state: "disabled",
    });
    // Consent screen where the professional unchecks the write scope.
    fake.denyWriteScope = true;
    expect(await authorizeWrite(s)).toBe("scope_missing");
    expect(await outboundRow(s)).toBeUndefined();
  });
});

describe("dedicated calendar", () => {
  it("is created once, named after the business, marked, and never an inbound blocking source", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const created = fake.appCalendars(s.account.sub);
    expect(created).toHaveLength(1);
    expect(created[0]!.summary).toBe(`Rendez-vous — ${s.name}`);
    const row = await outboundRow(s);
    expect(created[0]!.description).toContain(
      `booking-saas:${row!.calendar_marker}`,
    );
    expect(row).toMatchObject({
      status: "active",
      provider_calendar_id: calendarId,
    });
    expect(await status(s)).toMatchObject({
      state: "active",
      health: "healthy",
      calendarCreated: true,
      actionRequired: null,
    });

    // The calendar list now shows it: never selectable, never synced.
    sessionClient = s.owner.client;
    const calendars = ok(await listConnectedCalendarsAction({ refresh: true }));
    const booking = calendars.find((calendar) =>
      calendar.name.startsWith("Rendez-vous"),
    )!;
    expect(booking).toMatchObject({ bookingCalendar: true, selectable: false });
    expect(
      failed(
        await updateBlockingCalendarsAction({ calendarIds: [booking.id] }),
      ),
    ).toBe("calendar_not_selectable");

    // Booking appointment → mirror → inbound sync: no busy period from it.
    const appointment = await createAppointment(s, "10:00");
    await run(s);
    expect(liveEvents(calendarId)).toHaveLength(1);
    const work = calendars.find((calendar) => calendar.name === "Travail")!;
    ok(await updateBlockingCalendarsAction({ calendarIds: [work.id] }));
    await flush();
    ok(await syncGoogleCalendarNowAction());
    const { rows } = await db.query(
      "select count(*)::int as n from public.external_calendar_events where business_id = $1",
      [s.business.id],
    );
    expect(rows[0].n).toBe(0);
    expect(appointment.status).toBe("confirmed");
  });

  it("a calendar carrying this business's marker, or created for it before, is never selectable (lost creation, description edited)", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const row = await outboundRow(s);
    fake.setCalendars(s.account.sub, [
      {
        id: s.account.email,
        summary: "Personnel",
        timeZone: "UTC",
        primary: true,
      },
      // The dedicated calendar, its description edited by the professional:
      // the marker is gone, its id is still known.
      {
        id: calendarId,
        summary: "Mes rendez-vous",
        timeZone: "UTC",
        description: "Mes rendez-vous",
        appCreated: true,
      },
      // A copy left by a creation whose answer was lost (never adopted).
      {
        id: "orphan@group.calendar.google.com",
        summary: "Rendez-vous — copie",
        timeZone: "UTC",
        description: `booking-saas:${row!.calendar_marker}`,
        appCreated: true,
      },
    ]);
    sessionClient = s.owner.client;
    const calendars = ok(await listConnectedCalendarsAction({ refresh: true }));
    expect(
      calendars
        .filter((calendar) => calendar.bookingCalendar)
        .map((calendar) => [calendar.name, calendar.selectable])
        .sort(),
    ).toEqual([
      ["Mes rendez-vous", false],
      ["Rendez-vous — copie", false],
    ]);
    expect(
      calendars.find((calendar) => calendar.name === "Personnel"),
    ).toMatchObject({ bookingCalendar: false, selectable: true });
  });

  it("creation answer lost: the retry finds the calendar by its marker, never creates a second one", async () => {
    const s = await setup();
    await connect(s);
    fake.loseAnswer(
      (url, method) =>
        url.pathname === "/calendar/v3/calendars" && method === "POST",
    );
    expect(await authorizeWrite(s)).toBe("write_authorized");
    await flush();
    // Google created it; we never saw its id.
    expect(fake.appCalendars(s.account.sub)).toHaveLength(1);
    expect(await outboundRow(s)).toMatchObject({
      status: "creating",
      provider_calendar_id: null,
    });

    sessionClient = s.owner.client;
    ok(await retryCalendarOutboundAction());
    expect(await ensureOutboundCalendar(getCalendarDeps(), s.business.id)).toBe(
      "recovered",
    );
    expect(fake.appCalendars(s.account.sub)).toHaveLength(1);
    expect(await outboundRow(s)).toMatchObject({
      status: "active",
      provider_calendar_id: fake.appCalendars(s.account.sub)[0]!.id,
    });
    expect(
      fake.count(
        (url, method) =>
          url.pathname === "/calendar/v3/calendars" && method === "POST",
      ),
    ).toBe(1);
  });

  it("two workers initialising at once: one calendar, one configuration", async () => {
    const s = await setup();
    await connect(s);
    expect(await authorizeWrite(s)).toBe("write_authorized");
    background.length = 0;
    const deps = getCalendarDeps();
    const outcomes = await Promise.all([
      ensureOutboundCalendar(deps, s.business.id),
      ensureOutboundCalendar(deps, s.business.id),
      ensureOutboundCalendar(deps, s.business.id),
    ]);
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "busy")).toHaveLength(2);
    expect(fake.appCalendars(s.account.sub)).toHaveLength(1);
    // Enabling again while active changes nothing.
    sessionClient = s.owner.client;
    ok(await enableCalendarOutboundAction());
    await flush();
    expect(fake.appCalendars(s.account.sub)).toHaveLength(1);
    expect((await outboundRow(s))!.status).toBe("active");
  });
});

describe("mirrors: create, update, cancel", () => {
  it("a new appointment becomes one Google event: service times only, minimal title, no attendee, no notification", async () => {
    const s = await setup({ buffer: 15 });
    const calendarId = await enabled(s);
    const appointment = await createAppointment(s, "14:00");
    // Recorded by the appointment transaction itself, nothing sent yet.
    expect(await mirror(appointment.id)).toMatchObject({
      desired_revision: "1",
      applied_revision: "0",
      event_id: eventIdOf(appointment.id),
    });

    expect(await run(s)).toMatchObject({ applied: 1, retried: 0 });
    const [event] = liveEvents(calendarId);
    expect(event).toMatchObject({
      id: eventIdOf(appointment.id),
      summary: "Léa — Coupe",
      status: "confirmed",
      transparency: "opaque",
      start: { dateTime: expect.stringMatching(/^.+T14:00:00/) },
      end: { dateTime: expect.stringMatching(/^.+T15:00:00/) },
      extendedProperties: {
        private: {
          origin: "booking-saas",
          appointmentId: appointment.id,
          revision: "1",
        },
      },
    });
    expect(new Date(event!.start.dateTime!).toISOString()).toBe(at(D, "14:00"));
    // The buffer blocks Booking, not the visible event.
    expect(new Date(event!.end.dateTime!).toISOString()).toBe(at(D, "15:00"));
    const sent = fake.requests.find((request) =>
      isInsert(request.url, request.method),
    )!;
    expect(sent.url.searchParams.get("sendUpdates")).toBe("none");
    expect(sent.body).not.toMatch(
      /attendees|Martin|client\.test|\+336|Note interne/,
    );
    expect(await mirror(appointment.id)).toMatchObject({
      applied_revision: "1",
      provider_calendar_id: calendarId,
    });
    expect(await status(s)).toMatchObject({
      health: "healthy",
      pendingCount: 0,
    });
  });

  it("every write path records the desired state: public booking, manual creation, update, status", async () => {
    const s = await setup();
    await enabled(s);
    const { rows } = await db.query<{ appointment_id: string }>(
      `select appointment_id from private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Inès', $4)`,
      [s.business.slug, s.service, at(D, "09:00"), `${randomUUID()}@x.test`],
    );
    const publicId = rows[0]!.appointment_id;
    const manual = await createAppointment(s, "11:00");
    await reschedule(s, manual.id, "12:00");
    await changeStatus(s, manual.id, "cancelled");
    expect(await mirror(publicId)).toMatchObject({ desired_revision: "1" });
    expect(await mirror(manual.id)).toMatchObject({ desired_revision: "3" });
    // A change that does not show in Google (internal notes) records nothing.
    await db.query(
      "update public.appointments set internal_notes = 'x' where id = $1",
      [manual.id],
    );
    expect(await mirror(manual.id)).toMatchObject({ desired_revision: "3" });
  });

  it("reschedule converges on the same event; cancellation removes it; completed and no-show stay", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    const b = await createAppointment(s, "12:00", "Nora");
    await run(s);
    await reschedule(s, a.id, "16:00");
    // Completed / no-show (set once the appointment happened): kept.
    await db.query(
      "update public.appointments set status = 'no_show' where id = $1",
      [b.id],
    );
    await run(s);
    expect(
      liveEvents(calendarId).map((event) => [
        event.id,
        event.start.dateTime && new Date(event.start.dateTime).toISOString(),
      ]),
    ).toEqual(
      expect.arrayContaining([
        [eventIdOf(a.id), at(D, "16:00")],
        [eventIdOf(b.id), at(D, "12:00")],
      ]),
    );
    expect(fake.storedEvents(calendarId)).toHaveLength(2);

    await db.query(
      "update public.appointments set status = 'completed', completed_at = now() where id = $1",
      [b.id],
    );
    await changeStatus(s, a.id, "cancelled");
    await run(s);
    expect(liveEvents(calendarId).map((event) => event.id)).toEqual([
      eventIdOf(b.id),
    ]);
    // Deleting it again later (404/410) is a success.
    await db.query(
      "update private.appointment_calendar_mirrors set desired_revision = desired_revision + 1 where appointment_id = $1",
      [a.id],
    );
    expect(await run(s)).toMatchObject({ applied: 1, retried: 0 });
  });

  it("cancelled, then confirmed again: the same event id is restored, no duplicate", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    await run(s);
    await changeStatus(s, a.id, "cancelled");
    await run(s);
    expect(fake.storedEvents(calendarId)[0]!.status).toBe("cancelled");
    // Back to confirmed (a path the database allows).
    await db.query(
      "update public.appointments set status = 'confirmed', cancellation_reason = null where id = $1",
      [a.id],
    );
    await run(s);
    expect(fake.storedEvents(calendarId)).toHaveLength(1);
    expect(fake.storedEvents(calendarId)[0]).toMatchObject({
      id: eventIdOf(a.id),
      status: "confirmed",
    });

    // Deleted by the professional in Google, then changed in Booking:
    // restored with the same id.
    fake.deleteEvent(calendarId, eventIdOf(a.id));
    await reschedule(s, a.id, "11:00");
    await run(s);
    expect(fake.storedEvents(calendarId)).toHaveLength(1);
    expect(liveEvents(calendarId)[0]).toMatchObject({ id: eventIdOf(a.id) });
  });

  it("insert answer lost: one Google event only", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    // The insert reaches Google, its answer is lost (then retried: 409).
    fake.loseAnswer(isInsert);
    await run(s);
    expect(fake.storedEvents(calendarId)).toHaveLength(1);
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "1" });

    // Lost on every automatic retry: the mirror retries later, then
    // reconciles the existing event.
    const b = await createAppointment(s, "12:00");
    fake.loseAnswer(isInsert, 4);
    await run(s);
    expect(await mirror(b.id)).toMatchObject({
      applied_revision: "0",
      attempts: 1,
    });
    sessionClient = s.owner.client;
    ok(await retryCalendarOutboundAction());
    await run(s);
    expect(await mirror(b.id)).toMatchObject({ applied_revision: "1" });
    expect(
      fake
        .storedEvents(calendarId)
        .map((event) => event.id)
        .sort(),
    ).toEqual([eventIdOf(a.id), eventIdOf(b.id)].sort());

    // Insert reached Google but its answer was lost, then the appointment
    // is cancelled before any retry: the orphan event is still removed.
    const c = await createAppointment(s, "14:00");
    fake.loseAnswer(isInsert, 4);
    await run(s);
    expect(liveEvents(calendarId).map((event) => event.id)).toContain(
      eventIdOf(c.id),
    );
    await changeStatus(s, c.id, "cancelled");
    await run(s);
    expect(liveEvents(calendarId).map((event) => event.id)).not.toContain(
      eventIdOf(c.id),
    );
  });

  it("an existing deterministic id (409) is reconciled, never duplicated nor renamed", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    await run(s);
    await reschedule(s, a.id, "13:00");
    // As if the event's existence had not been recorded.
    await db.query(
      "update private.appointment_calendar_mirrors set provider_calendar_id = null where appointment_id = $1",
      [a.id],
    );
    await run(s);
    expect(fake.storedEvents(calendarId)).toHaveLength(1);
    expect(
      new Date(liveEvents(calendarId)[0]!.start.dateTime!).toISOString(),
    ).toBe(at(D, "13:00"));
  });

  it("Google unavailable: the booking succeeds, the mirror retries with backoff, then converges", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    // Every attempt of the first run (one call and its 3 retries).
    fake.failNext((url) => url.pathname.includes("/events"), 503, 4);
    const before = providerCalls();
    const a = await createAppointment(s, "10:00");
    // The appointment's transaction made no provider call.
    expect(providerCalls()).toBe(before);
    expect((await appointmentRow(a.id)).status).toBe("confirmed");
    await run(s);
    expect(await mirror(a.id)).toMatchObject({
      applied_revision: "0",
      attempts: 1,
      last_error: "unavailable",
    });
    expect(await status(s)).toMatchObject({
      health: "retrying",
      errorCount: 1,
    });
    // Not due before its backoff.
    expect(await run(s)).toMatchObject({ applied: 0, retried: 0 });
    await db.query(
      "update private.appointment_calendar_mirrors set next_attempt_at = now() where appointment_id = $1",
      [a.id],
    );
    await run(s);
    expect(liveEvents(calendarId)).toHaveLength(1);
    expect(await status(s)).toMatchObject({ health: "healthy" });
  });

  it("public booking never calls Google, even when it fails", async () => {
    const s = await setup();
    await enabled(s);
    fake.failNext(() => true, 500, 100);
    const before = fake.requests.length;
    const { rows } = await db.query<{ appointment_id: string }>(
      `select appointment_id from private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Inès', $4)`,
      [s.business.slug, s.service, at(D, "09:00"), `${randomUUID()}@x.test`],
    );
    expect(rows[0]!.appointment_id).toBeDefined();
    expect(fake.requests.length).toBe(before);
  });
});

describe("concurrency and authority", () => {
  it("created then cancelled before any worker: only the final state (no call at all)", async () => {
    const s = await setup();
    await enabled(s);
    const writes = googleWrites();
    const a = await createAppointment(s, "10:00");
    await changeStatus(s, a.id, "cancelled");
    await run(s);
    expect(googleWrites()).toBe(writes);
    expect(await mirror(a.id)).toMatchObject({
      desired_revision: "2",
      applied_revision: "2",
    });
  });

  it("created then rescheduled twice before any worker: one insert, the last time", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    await reschedule(s, a.id, "11:00");
    await reschedule(s, a.id, "15:00");
    await run(s);
    expect(fake.count(isInsert)).toBe(1);
    expect(fake.count((url, method) => method === "PUT")).toBe(0);
    expect(
      new Date(liveEvents(calendarId)[0]!.start.dateTime!).toISOString(),
    ).toBe(at(D, "15:00"));
  });

  it("two workers on the same appointment: one event", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await createAppointment(s, "10:00");
    await Promise.all([run(s), run(s), run(s)]);
    expect(fake.storedEvents(calendarId)).toHaveLength(1);
    expect(fake.count(isInsert)).toBe(1);
  });

  it("a revision recorded while the worker is at Google stays due: the latest state wins", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    const held = fake.hold(isInsert);
    const worker = run(s);
    await held.reached;
    await reschedule(s, a.id, "17:00");
    held.release();
    await worker;
    expect(await mirror(a.id)).toMatchObject({
      desired_revision: "2",
      applied_revision: "1",
    });
    await run(s);
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "2" });
    expect(
      new Date(liveEvents(calendarId)[0]!.start.dateTime!).toISOString(),
    ).toBe(at(D, "17:00"));
  });

  it.each([
    [
      "disconnect",
      async (s: Setup) => {
        sessionClient = s.owner.client;
        ok(await disconnectGoogleCalendarAction());
      },
    ],
    [
      "reconnect (same account, new credentials)",
      async (s: Setup) => {
        await connect(s);
      },
    ],
    [
      "outbound disabled",
      async (s: Setup) => {
        sessionClient = s.owner.client;
        ok(await disableCalendarOutboundAction());
      },
    ],
    [
      "action required",
      async (s: Setup) => {
        const row = await outboundRow(s);
        await db.query(
          "select public.calendar_outbound_mark_action_required($1, $2, 'calendar_deleted')",
          [s.business.id, row!.generation],
        );
      },
    ],
  ])(
    "worker at Google, then %s: its late answer has no local authority",
    async (_label, change) => {
      const s = await setup();
      await enabled(s);
      const a = await createAppointment(s, "10:00");
      const held = fake.hold(isInsert);
      const worker = run(s);
      await held.reached;
      await change(s);
      held.release();
      expect(await worker).toMatchObject({ applied: 0, superseded: 1 });
      expect(await mirror(a.id)).toMatchObject({ applied_revision: "0" });
      // No provider write afterwards for this configuration.
      const writes = googleWrites();
      await run(s);
      expect(googleWrites()).toBe(writes);
    },
  );

  it("worker at Google on the former calendar, then reactivation: no authority on the new incarnation", async () => {
    const s = await setup();
    const first = await enabled(s);
    const a = await createAppointment(s, "10:00");
    const held = fake.hold(isInsert);
    const worker = run(s);
    await held.reached;
    // Meanwhile: the calendar is deleted, detected, and reactivated.
    fake.deleteCalendar(first);
    const row = await outboundRow(s);
    await db.query(
      "select public.calendar_outbound_mark_action_required($1, $2, 'calendar_deleted')",
      [s.business.id, row!.generation],
    );
    sessionClient = s.owner.client;
    ok(await reactivateCalendarOutboundAction());
    background.length = 0;
    expect(await ensureOutboundCalendar(getCalendarDeps(), s.business.id)).toBe(
      "created",
    );
    held.release();
    expect(await worker).toMatchObject({ applied: 0, superseded: 1 });
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "0" });
    await run(s);
    const second = (await outboundRow(s))!.provider_calendar_id!;
    expect(second).not.toBe(first);
    expect(liveEvents(second).map((event) => event.id)).toEqual([
      eventIdOf(a.id),
    ]);
  });

  it("a worker that crashed after claiming: the claim expires and the change still converges", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    const { rows } = await db.query(
      "select public.calendar_outbound_claim_mirrors(10, $1, 10) as claims",
      [s.business.id],
    );
    expect(rows[0].claims).toHaveLength(1);
    // Nothing more: the process died. Still claimed:
    expect(await run(s)).toMatchObject({ applied: 0 });
    await db.query(
      "update private.appointment_calendar_mirrors set lease_until = now() - interval '1 second' where appointment_id = $1",
      [a.id],
    );
    await run(s);
    expect(liveEvents(calendarId)).toHaveLength(1);
  });
});

describe("dedicated calendar deleted by the professional", () => {
  it("next provider call: action required at once, appointments intact, no new calendar, no retry storm (200 appointments)", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const { rows: clients } = await db.query<{ id: string }>(
      "insert into public.clients (business_id, first_name) values ($1, 'Lot') returning id",
      [s.business.id],
    );
    await db.query(
      `insert into public.appointments (
         business_id, client_id, service_id, starts_at, ends_at,
         service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot
       )
       select $1, $2, $3,
              ($4::date + interval '1 day' * i + time '08:00'),
              ($4::date + interval '1 day' * i + time '08:30'),
              'Coupe', 30, 1000
       from generate_series(1, 200) i`,
      [s.business.id, clients[0]!.id, s.service, D],
    );
    fake.deleteCalendar(calendarId);
    const calls = providerCalls();

    await run(s);
    // One insert (404) and one check of the calendar, then nothing.
    expect(providerCalls() - calls).toBe(2);
    expect(await outboundRow(s)).toMatchObject({
      status: "action_required",
      action_code: "calendar_deleted",
      provider_calendar_id: null,
    });
    const { rows } = await db.query(
      `select count(*) filter (where m.attempts > 0)::int as failed,
              count(*) filter (where m.desired_revision > m.applied_revision)::int as pending,
              (select count(*)::int from public.appointments a where a.business_id = $1 and a.status = 'confirmed') as confirmed
       from private.appointment_calendar_mirrors m where m.business_id = $1`,
      [s.business.id],
    );
    expect(rows[0]).toEqual({ failed: 0, pending: 200, confirmed: 200 });
    // Nothing more is tried, nothing is created behind the professional.
    await run(s);
    await run(s);
    expect(providerCalls() - calls).toBe(2);
    expect(fake.appCalendars(s.account.sub)).toHaveLength(0);
    expect(await status(s)).toMatchObject({
      health: "action_required",
      actionRequired: "reactivate",
      reason: "calendar_deleted",
      calendarCreated: false,
      pendingCount: 200,
    });
  });

  it("during action required: creations, moves and cancellations keep their latest desired state, without any provider call", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const b = await createAppointment(s, "10:00", "Bea");
    const c = await createAppointment(s, "12:00", "Cleo");
    await run(s);
    fake.deleteCalendar(calendarId);
    await reschedule(s, b.id, "11:00");
    await run(s);
    expect((await outboundRow(s))!.status).toBe("action_required");

    const calls = providerCalls();
    const a = await createAppointment(s, "08:00", "Alma");
    await reschedule(s, a.id, "09:00");
    await reschedule(s, b.id, "13:00");
    await reschedule(s, b.id, "14:00");
    await changeStatus(s, c.id, "cancelled");
    await run(s);
    expect(providerCalls()).toBe(calls);
    expect((await appointmentRow(b.id)).starts_at.toISOString()).toBe(
      at(D, "14:00"),
    );
    expect(await mirror(a.id)).toMatchObject({
      desired_revision: "2",
      applied_revision: "0",
    });
    expect(await mirror(b.id)).toMatchObject({
      desired_revision: "4",
      applied_revision: "1",
    });
    expect(await mirror(c.id)).toMatchObject({
      desired_revision: "2",
      applied_revision: "1",
    });
  });

  it("explicit reactivation: new calendar and generation; every enrolled appointment still active converges there (synced before, moved or created meanwhile), cancelled ones are not recreated, no general rescan", async () => {
    const s = await setup();
    // Before the very first activation: never enrolled (backfill #11b).
    const never = await createAppointment(s, "08:00", "Old");
    const first = await enabled(s);
    const a = await createAppointment(s, "09:00", "Ana");
    const b = await createAppointment(s, "10:00", "Bea");
    const c = await createAppointment(s, "12:00", "Cy");
    await run(s);
    expect(liveEvents(first)).toHaveLength(3);
    // Another tenant, synced as well: never concerned.
    const neighbour = await setup();
    const neighbourCalendar = await enabled(neighbour);
    const n = await createAppointment(neighbour, "10:00", "Nil");
    await run(neighbour);
    const neighbourMirror = await mirror(n.id);

    // Calendar 1 deleted by the professional: action required.
    fake.deleteCalendar(first);
    await reschedule(s, b.id, "11:00");
    await run(s);
    const before = await outboundRow(s);
    expect(before).toMatchObject({
      status: "action_required",
      action_code: "calendar_deleted",
    });
    // Meanwhile: B moved again, C cancelled, D created, A unchanged.
    const calls = providerCalls();
    await reschedule(s, b.id, "16:00");
    await changeStatus(s, c.id, "cancelled");
    const d = await createAppointment(s, "15:00", "Dan");
    await run(s);
    expect(providerCalls()).toBe(calls);
    const inserts = fake.count(isInsert);

    sessionClient = s.owner.client;
    const result = ok(await reactivateCalendarOutboundAction());
    expect(result.authorizationUrl).toBeNull();
    expect(result.status).toMatchObject({
      state: "creating",
      health: "pending",
    });
    await flush();

    const after = await outboundRow(s);
    expect(after!.status).toBe("active");
    expect(after!.generation).not.toBe(before!.generation);
    const second = after!.provider_calendar_id!;
    expect(second).not.toBe(first);
    expect(
      fake.appCalendars(s.account.sub).map((calendar) => calendar.id),
    ).toEqual([second]);
    // A (synced before, unchanged), B (latest time), D (created meanwhile):
    // same deterministic ids, one insert each. C is not recreated; the
    // appointment never enrolled is not discovered.
    expect(
      liveEvents(second)
        .map((event) => [
          event.id,
          new Date(event.start.dateTime!).toISOString(),
        ])
        .sort(),
    ).toEqual(
      [
        [eventIdOf(a.id), at(D, "09:00")],
        [eventIdOf(b.id), at(D, "16:00")],
        [eventIdOf(d.id), at(D, "15:00")],
      ].sort(),
    );
    expect(fake.storedEvents(second)).toHaveLength(3);
    expect(fake.count(isInsert) - inserts).toBe(3);
    expect(await mirror(never.id)).toBeUndefined();
    expect(await mirror(c.id)).toMatchObject({
      desired_revision: "2",
      applied_revision: "2",
    });
    expect(await status(s)).toMatchObject({
      health: "healthy",
      pendingCount: 0,
    });
    // Converged: nothing more to send.
    await run(s);
    expect(fake.count(isInsert) - inserts).toBe(3);
    // The other tenant's mirror and calendar are untouched.
    expect(await mirror(n.id)).toEqual(neighbourMirror);
    expect(liveEvents(neighbourCalendar).map((event) => event.id)).toEqual([
      eventIdOf(n.id),
    ]);
  });
});

describe("disconnect and reconnect", () => {
  it("disconnect: outbound stops, appointments intact, no write afterwards, new appointments not enrolled", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    const a = await createAppointment(s, "10:00");
    await run(s);
    sessionClient = s.owner.client;
    ok(await disconnectGoogleCalendarAction());
    expect(await outboundRow(s)).toMatchObject({
      status: "disabled",
      provider_calendar_id: null,
    });
    expect((await appointmentRow(a.id)).status).toBe("confirmed");
    const writes = googleWrites();
    await changeStatus(s, a.id, "cancelled");
    const b = await createAppointment(s, "12:00");
    await run(s);
    expect(googleWrites()).toBe(writes);
    expect(await mirror(b.id)).toBeUndefined();
    // The event stays in Google (no remote cleanup required).
    expect(liveEvents(calendarId)).toHaveLength(1);
    expect(await status(s)).toMatchObject({
      googleConnected: false,
      enabled: false,
      health: "disabled",
    });
  });

  it("reconnect with the same account: same calendar, no new one, mirrors go on", async () => {
    const s = await setup();
    const calendarId = await enabled(s);
    await connect(s);
    const a = await createAppointment(s, "10:00");
    await run(s);
    expect(fake.appCalendars(s.account.sub)).toHaveLength(1);
    expect(liveEvents(calendarId).map((event) => event.id)).toEqual([
      eventIdOf(a.id),
    ]);

    // Disconnected, reconnected, enabled again: the same calendar is found.
    sessionClient = s.owner.client;
    ok(await disconnectGoogleCalendarAction());
    await db.query(
      "update public.calendar_connections set revocation_pending_until = null where business_id = $1",
      [s.business.id],
    );
    await connect(s);
    sessionClient = s.owner.client;
    ok(await enableCalendarOutboundAction());
    await flush();
    expect(fake.appCalendars(s.account.sub)).toHaveLength(1);
    expect((await outboundRow(s))!.provider_calendar_id).toBe(calendarId);
  });

  it("account A → account B: A's configuration invalidated, B's credentials never touch A's calendar, A's workers no-op; explicit activation at B replays every enrolled active appointment, unchanged ones included", async () => {
    const s = await setup();
    const calendarA = await enabled(s);
    const a1 = await createAppointment(s, "09:00", "Un");
    const a2 = await createAppointment(s, "10:00", "Deux");
    const gone = await createAppointment(s, "12:00", "Trois");
    await run(s);
    expect(liveEvents(calendarA)).toHaveLength(3);
    const writesToA = () =>
      fake.requests.filter(
        (request) =>
          decodeURIComponent(request.url.pathname).includes(calendarA) &&
          request.method !== "GET",
      ).length;

    // A worker of A's incarnation is at Google when B replaces A.
    const late = await createAppointment(s, "14:00", "Tard");
    const held = fake.hold(isInsert);
    const worker = run(s);
    await held.reached;
    const other = newAccount();
    givePersonalCalendars(other);
    await connect(s, other);
    held.release();
    expect(await worker).toMatchObject({ applied: 0, superseded: 1 });
    const toA = writesToA();
    const generationAfterSwitch = (await outboundRow(s))!.generation;
    expect(await outboundRow(s)).toMatchObject({
      status: "disabled",
      action_code: "account_changed",
      provider_calendar_id: null,
    });
    expect(await status(s)).toMatchObject({
      health: "disabled",
      actionRequired: "enable_again",
    });
    await changeStatus(s, gone.id, "cancelled");
    const writes = googleWrites();
    await run(s);
    expect(googleWrites()).toBe(writes);

    // B grants the write scope (explicit activation): a new calendar at B.
    expect(await authorizeWrite(s, other)).toBe("write_authorized");
    await flush();
    const row = await outboundRow(s);
    const [calendarB] = fake.appCalendars(other.sub);
    expect(row).toMatchObject({
      status: "active",
      provider_calendar_id: calendarB!.id,
    });
    expect(row!.generation).not.toBe(generationAfterSwitch);
    // A1 and A2 replayed although unchanged, with the same ids; the late
    // one too; the cancelled one is not recreated. No duplicate.
    expect(
      liveEvents(calendarB!.id)
        .map((event) => event.id)
        .sort(),
    ).toEqual([eventIdOf(a1.id), eventIdOf(a2.id), eventIdOf(late.id)].sort());
    expect(fake.storedEvents(calendarB!.id)).toHaveLength(3);
    // Nothing written to A's calendar since B took over; its events stay
    // there (no remote cleanup in V1).
    expect(writesToA()).toBe(toA);
    expect(
      liveEvents(calendarA)
        .map((event) => event.id)
        .sort(),
    ).toEqual(
      [
        eventIdOf(a1.id),
        eventIdOf(a2.id),
        eventIdOf(gone.id),
        eventIdOf(late.id),
      ].sort(),
    );
    await run(s);
    expect(fake.storedEvents(calendarB!.id)).toHaveLength(3);
  });
});

describe("tenant isolation", () => {
  it("a professional can neither read nor act on another business's outbound", async () => {
    const s = await setup();
    await enabled(s);
    const a = await createAppointment(s, "10:00");
    const intruder = await setup();
    await connect(intruder);

    for (const fn of [
      "calendar_outbound_status",
      "calendar_outbound_enable",
      "calendar_outbound_disable",
      "calendar_outbound_retry",
    ] as const) {
      const { error } = await intruder.owner.client.rpc(fn, {
        p_business_id: s.business.id,
      });
      expect(error?.message).toBe("forbidden");
    }
    // Worker functions are not callable from a session at all.
    const { error: claimError } = await intruder.owner.client.rpc(
      "calendar_outbound_claim_mirrors",
      { p_limit: 10, p_business_id: s.business.id, p_per_business: 10 },
    );
    expect(claimError).not.toBeNull();
    const { error: markError } = await intruder.owner.client.rpc(
      "calendar_outbound_mark_action_required",
      {
        p_business_id: s.business.id,
        p_generation: randomUUID(),
        p_action_code: "calendar_deleted",
      },
    );
    expect(markError).not.toBeNull();
    // The intruder's own status says nothing about the other business.
    sessionClient = intruder.owner.client;
    expect(await status(intruder)).toMatchObject({
      enabled: false,
      pendingCount: 0,
    });
    expect((await outboundRow(s))!.status).toBe("active");
    expect(await mirror(a.id)).toMatchObject({ applied_revision: "0" });
    // No token, secret or provider id leaks through the statuses.
    sessionClient = s.owner.client;
    const dto = JSON.stringify([
      await status(s),
      ok(await getCalendarIntegrationStatusAction()),
    ]);
    expect(dto).not.toMatch(/at-|rt-|ciphertext|@group\.calendar/);
  });
});
