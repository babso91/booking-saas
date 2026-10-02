import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createBusiness,
  createProfessional,
  createService,
  db,
  everyDay,
  setWeeklyHours,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
} from "./support/transactions";

// How provider events become busy periods, through the same SQL function the
// sync uses (public.calendar_apply_events), with a fixed sync window and a
// fixed "now": every expectation is an explicit UTC instant and the date of
// the run never matters. PostgreSQL alone converts dates (all-day events)
// with the calendar's zone; explicit offsets are kept as given.

const NOW = "2026-09-01T00:00:00Z";

type Calendar = {
  businessId: string;
  calendarId: string;
  serviceId: string;
  /** The claim a worker holds on the calendar (write authority). */
  claimId: string;
};

async function calendar(options: {
  businessZone: string;
  calendarZone: string | null;
}): Promise<Calendar> {
  const owner = await createProfessional("temporal");
  const business = await createBusiness(owner.userId, {
    timezone: options.businessZone,
    settings: {
      slot_interval_minutes: 60,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
    },
  });
  await setWeeklyHours(business.id, everyDay(["00:00", "24:00"]));
  const serviceId = await createService(business.id, { durationMinutes: 60 });
  const { rows } = await db.query<{ id: string }>(
    `with c as (
       insert into public.calendar_connections (business_id, provider, provider_account_id, account_email)
       values ($1, 'google', $2, 'x@gmail.test') returning id
     )
     insert into public.external_calendars
       (business_id, connection_id, provider_calendar_id, name, timezone, selected_for_blocking)
     select $1, c.id, 'cal', 'Travail', $3, true from c
     returning id`,
    [business.id, `sub-${randomUUID()}`, options.calendarZone],
  );
  const claimId = randomUUID();
  await db.query(
    `insert into private.external_calendar_sync
       (calendar_id, generation, allocated_generation, sync_token, window_start, window_end, claim_id, lease_until)
     values ($1, 1, 1, 'sync-0', '2010-01-01T00:00Z', '2030-01-01T00:00Z', $2, now() + interval '10 minutes')`,
    [rows[0]!.id, claimId],
  );
  return {
    businessId: business.id,
    calendarId: rows[0]!.id,
    serviceId,
    claimId,
  };
}

/** Applies an incremental page (provider zone: the page's, if given). */
async function apply(
  c: Calendar,
  events: unknown[],
  providerZone: string | null = null,
) {
  const { rows } = await db.query<{
    result: { applied: boolean; reason?: string };
  }>(
    "select public.calendar_apply_events($1, $2, null, $3, $4::jsonb) as result",
    [c.calendarId, c.claimId, providerZone, JSON.stringify(events)],
  );
  return rows[0]!.result;
}

async function applied(c: Calendar, events: unknown[]) {
  expect((await apply(c, events)).applied).toBe(true);
}

async function busy(c: Calendar) {
  const { rows } = await db.query<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    all_day: boolean;
  }>(
    `select provider_event_id as id, starts_at, ends_at, all_day
     from public.external_calendar_events where external_calendar_id = $1 order by starts_at`,
    [c.calendarId],
  );
  return rows.map((row) => [
    row.id,
    row.starts_at.toISOString(),
    row.ends_at.toISOString(),
    row.all_day,
  ]);
}

async function slots(c: Calendar, date: string) {
  const { rows } = await db.query<{ starts_at: Date }>(
    "select starts_at from private.available_slots($1, $2, $3::date, $4::timestamptz)",
    [c.businessId, c.serviceId, date, NOW],
  );
  return rows.map((row) => row.starts_at.toISOString());
}

const allDay = (
  id: string,
  start: string,
  end: string,
  extra: object = {},
) => ({
  id,
  status: "confirmed",
  start: { date: start },
  end: { date: end },
  ...extra,
});

describe("timed events", () => {
  it("keeps an explicit offset exactly (never rebuilt from the wall clock)", async () => {
    const c = await calendar({
      businessZone: "Europe/Paris",
      calendarZone: "Europe/Paris",
    });
    await applied(c, [
      // 02:30 happens twice in Paris on 25 Oct 2026: the offset says which.
      {
        id: "first",
        start: { dateTime: "2026-10-25T02:30:00+02:00" },
        end: { dateTime: "2026-10-25T02:45:00+02:00" },
      },
      {
        id: "second",
        start: { dateTime: "2026-10-25T02:30:00+01:00" },
        end: { dateTime: "2026-10-25T02:45:00+01:00" },
      },
      {
        id: "utc",
        start: { dateTime: "2026-10-25T10:00:00Z" },
        end: { dateTime: "2026-10-25T11:00:00Z" },
      },
    ]);
    expect(await busy(c)).toEqual([
      ["first", "2026-10-25T00:30:00.000Z", "2026-10-25T00:45:00.000Z", false],
      ["second", "2026-10-25T01:30:00.000Z", "2026-10-25T01:45:00.000Z", false],
      ["utc", "2026-10-25T10:00:00.000Z", "2026-10-25T11:00:00.000Z", false],
    ]);
  });

  it("reads a date-time without offset in its zone, through PostgreSQL", async () => {
    const c = await calendar({
      businessZone: "Europe/Paris",
      calendarZone: "Europe/Paris",
    });
    await applied(c, [
      {
        id: "ny",
        start: {
          dateTime: "2026-10-02T10:00:00",
          timeZone: "America/New_York",
        },
        end: { dateTime: "2026-10-02T11:00:00", timeZone: "America/New_York" },
      },
      {
        id: "fallback",
        start: { dateTime: "2026-10-02T10:00:00", timeZone: "Mars/Olympus" },
        end: { dateTime: "2026-10-02T11:00:00" },
      },
    ]);
    expect(await busy(c)).toEqual([
      [
        "fallback",
        "2026-10-02T08:00:00.000Z",
        "2026-10-02T09:00:00.000Z",
        false,
      ],
      ["ny", "2026-10-02T14:00:00.000Z", "2026-10-02T15:00:00.000Z", false],
    ]);
  });
});

describe("all-day events", () => {
  it("Paris 25-hour day: the whole real day, end date exclusive", async () => {
    const c = await calendar({
      businessZone: "Europe/Paris",
      calendarZone: "Europe/Paris",
    });
    await applied(c, [allDay("autumn", "2026-10-25", "2026-10-26")]);
    expect(await busy(c)).toEqual([
      ["autumn", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", true],
    ]);
    expect(await slots(c, "2026-10-25")).toEqual([]);
    expect(await slots(c, "2026-10-24")).toHaveLength(24);
    expect((await slots(c, "2026-10-26"))[0]).toBe("2026-10-25T23:00:00.000Z");
  });

  it("Paris 23-hour day", async () => {
    const c = await calendar({
      businessZone: "Europe/Paris",
      calendarZone: "Europe/Paris",
    });
    await applied(c, [allDay("spring", "2027-03-28", "2027-03-29")]);
    expect(await busy(c)).toEqual([
      ["spring", "2027-03-27T23:00:00.000Z", "2027-03-28T22:00:00.000Z", true],
    ]);
    expect(await slots(c, "2027-03-28")).toEqual([]);
    expect(await slots(c, "2027-03-29")).toHaveLength(24);
  });

  it("Havana repeated midnight: from the first midnight, 25 real hours", async () => {
    const c = await calendar({
      businessZone: "America/Havana",
      calendarZone: "America/Havana",
    });
    await applied(c, [allDay("havana", "2026-11-01", "2026-11-02")]);
    expect(await busy(c)).toEqual([
      ["havana", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", true],
    ]);
    expect(await slots(c, "2026-11-01")).toEqual([]);
    expect((await slots(c, "2026-10-31")).at(-1)).toBe(
      "2026-11-01T03:00:00.000Z",
    );
  });

  it("several days (vacation), multi-day and the calendar's zone, not the business's", async () => {
    // Business in Paris, calendar in New York: the dates are New York dates.
    const c = await calendar({
      businessZone: "Europe/Paris",
      calendarZone: "America/New_York",
    });
    await applied(c, [allDay("trip", "2026-10-02", "2026-10-05")]);
    expect(await busy(c)).toEqual([
      ["trip", "2026-10-02T04:00:00.000Z", "2026-10-05T04:00:00.000Z", true],
    ]);
    // Paris 2 Oct: free until 06:00 Paris (04:00Z).
    expect(await slots(c, "2026-10-02")).toEqual([
      "2026-10-01T22:00:00.000Z",
      "2026-10-01T23:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-02T01:00:00.000Z",
      "2026-10-02T02:00:00.000Z",
      "2026-10-02T03:00:00.000Z",
    ]);
    expect(await slots(c, "2026-10-04")).toEqual([]);
  });

  it("an event-level zone wins over the calendar's", async () => {
    const c = await calendar({
      businessZone: "Europe/Paris",
      calendarZone: "Europe/Paris",
    });
    await applied(c, [
      allDay("tokyo", "2026-10-02", "2026-10-03", {
        start: { date: "2026-10-02", timeZone: "Asia/Tokyo" },
      }),
    ]);
    expect((await busy(c))[0]!.slice(1, 3)).toEqual([
      "2026-10-01T15:00:00.000Z",
      "2026-10-02T15:00:00.000Z",
    ]);
  });

  it("Apia: a date that does not exist blocks nothing", async () => {
    const c = await calendar({
      businessZone: "Pacific/Apia",
      calendarZone: "Pacific/Apia",
    });
    await applied(c, [
      allDay("missing", "2011-12-30", "2011-12-31"),
      allDay("around", "2011-12-29", "2011-12-31"),
    ]);
    expect(await busy(c)).toEqual([
      ["around", "2011-12-29T10:00:00.000Z", "2011-12-30T10:00:00.000Z", true],
    ]);
  });
});

describe("idempotence, order and window", () => {
  it("re-applying the same page changes nothing; an older version never wins", async () => {
    const c = await calendar({ businessZone: "UTC", calendarZone: "UTC" });
    const v2 = {
      id: "e",
      updated: "2026-09-02T10:00:00Z",
      start: { dateTime: "2026-10-02T15:00:00Z" },
      end: { dateTime: "2026-10-02T16:00:00Z" },
    };
    const v1 = {
      ...v2,
      updated: "2026-09-01T10:00:00Z",
      start: { dateTime: "2026-10-02T09:00:00Z" },
      end: { dateTime: "2026-10-02T10:00:00Z" },
    };
    await applied(c, [v2]);
    await applied(c, [v2]);
    await applied(c, [v1]);
    expect(await busy(c)).toEqual([
      ["e", "2026-10-02T15:00:00.000Z", "2026-10-02T16:00:00.000Z", false],
    ]);
  });

  it("drops events outside the window", async () => {
    const c = await calendar({ businessZone: "UTC", calendarZone: "UTC" });
    await applied(c, [
      {
        id: "old",
        start: { dateTime: "2008-01-01T10:00:00Z" },
        end: { dateTime: "2008-01-01T11:00:00Z" },
      },
      {
        id: "far",
        start: { dateTime: "2031-01-01T10:00:00Z" },
        end: { dateTime: "2031-01-01T11:00:00Z" },
      },
      {
        id: "kept",
        start: { dateTime: "2026-10-02T10:00:00Z" },
        end: { dateTime: "2026-10-02T11:00:00Z" },
      },
    ]);
    expect((await busy(c)).map((row) => row[0])).toEqual(["kept"]);
  });

  it("an unreadable, empty, inverted or id-less event rejects the whole page (never silently dropped)", async () => {
    const c = await calendar({ businessZone: "UTC", calendarZone: "UTC" });
    // A valid busy period already in the copy must survive every rejection.
    await applied(c, [
      {
        id: "cached",
        start: { dateTime: "2026-10-05T10:00:00Z" },
        end: { dateTime: "2026-10-05T11:00:00Z" },
      },
    ]);
    const good = {
      id: "good",
      start: { dateTime: "2026-10-02T10:00:00Z" },
      end: { dateTime: "2026-10-02T11:00:00Z" },
    };
    for (const bad of [
      {
        id: "broken",
        start: { dateTime: "not a date" },
        end: { dateTime: "2026-10-02T10:00:00Z" },
      },
      { id: "", start: good.start, end: good.end },
      { start: good.start, end: good.end },
      { id: "no-end", start: good.start },
      // Empty or inverted intervals, inverted civil dates, mixed bounds.
      { id: "empty", start: good.start, end: good.start },
      { id: "inverted", start: good.end, end: good.start },
      allDay("inverted-day", "2026-10-03", "2026-10-02"),
      allDay("empty-day", "2026-10-02", "2026-10-02"),
      { id: "mixed", start: { date: "2026-10-02" }, end: good.end },
      {
        id: "bad-offset",
        start: { dateTime: "2026-10-02T10:00:00+25:00" },
        end: good.end,
      },
    ]) {
      await expect(apply(c, [good, bad])).rejects.toMatchObject({
        message: "invalid_input",
      });
    }
    // Nothing of the rejected pages was applied, nothing was deleted.
    expect(await busy(c)).toEqual([
      ["cached", "2026-10-05T10:00:00.000Z", "2026-10-05T11:00:00.000Z", false],
    ]);
    // Even a page that would move the cached event to an empty interval.
    await expect(
      apply(c, [
        {
          id: "cached",
          start: { dateTime: "2026-10-05T10:00:00Z" },
          end: { dateTime: "2026-10-05T10:00:00Z" },
        },
      ]),
    ).rejects.toMatchObject({ message: "invalid_input" });
    expect((await busy(c)).map((row) => row[0])).toEqual(["cached"]);
  });

  it("a full sync's final sweep removes what was not seen again", async () => {
    const c = await calendar({ businessZone: "UTC", calendarZone: "UTC" });
    await applied(c, [
      {
        id: "a",
        start: { dateTime: "2026-10-02T10:00:00Z" },
        end: { dateTime: "2026-10-02T11:00:00Z" },
      },
      {
        id: "b",
        start: { dateTime: "2026-10-03T10:00:00Z" },
        end: { dateTime: "2026-10-03T11:00:00Z" },
      },
    ]);
    const { rows } = await db.query<{ start: { generation: number } }>(
      "select public.calendar_start_full_sync($1, $2) as start",
      [c.calendarId, c.claimId],
    );
    const generation = rows[0]!.start.generation;
    await db.query(
      "select public.calendar_apply_events($1, $2, $3, null, $4::jsonb, 'p2')",
      [
        c.calendarId,
        c.claimId,
        generation,
        JSON.stringify([
          {
            id: "a",
            start: { dateTime: "2026-10-02T10:00:00Z" },
            end: { dateTime: "2026-10-02T11:00:00Z" },
          },
        ]),
      ],
    );
    // Before the end, both still block (no window without blocking).
    expect((await busy(c)).map((row) => row[0])).toEqual(["a", "b"]);
    await db.query(
      "select public.calendar_finish_full_sync($1, $2, $3, 'sync-9')",
      [c.calendarId, c.claimId, generation],
    );
    expect((await busy(c)).map((row) => row[0])).toEqual(["a"]);
    // A stale generation is refused.
    const stale = await db.query(
      "select public.calendar_finish_full_sync($1, $2, $3, 'x') as done",
      [c.calendarId, c.claimId, generation],
    );
    expect(stale.rows[0].done).toBe(false);
  });
});

describe("calendar time zone change", () => {
  // A full sync of the claimant with a fixed window (the run date never
  // matters): start, apply the provider pages, finish with a sweep.
  async function fullSync(c: Calendar, zone: string, events: unknown[]) {
    const { rows } = await db.query<{ start: { generation: number } }>(
      "select public.calendar_start_full_sync($1, $2) as start",
      [c.calendarId, c.claimId],
    );
    const generation = rows[0]!.start.generation;
    await db.query(
      `update private.external_calendar_sync
       set full_window_start = '2010-01-01T00:00Z', full_window_end = '2030-01-01T00:00Z'
       where calendar_id = $1`,
      [c.calendarId],
    );
    const applied = await db.query<{ result: { applied: boolean } }>(
      "select public.calendar_apply_events($1, $2, $3, $4, $5::jsonb) as result",
      [c.calendarId, c.claimId, generation, zone, JSON.stringify(events)],
    );
    expect(applied.rows[0]!.result.applied).toBe(true);
    const finished = await db.query<{ done: boolean }>(
      "select public.calendar_finish_full_sync($1, $2, $3, 'sync-x') as done",
      [c.calendarId, c.claimId, generation],
    );
    expect(finished.rows[0]!.done).toBe(true);
    return generation;
  }

  async function state(c: Calendar) {
    const { rows } = await db.query(
      `select c.timezone, c.sync_status, s.sync_token, s.full_generation
       from public.external_calendars c
       join private.external_calendar_sync s on s.calendar_id = c.id
       where c.id = $1`,
      [c.calendarId],
    );
    return rows[0];
  }

  const events = [
    allDay("day", "2026-10-20", "2026-10-21"),
    // Crosses the end of summer time in Paris (25 Oct) and New York (1 Nov).
    allDay("multi", "2026-10-24", "2026-11-03"),
    {
      id: "offset",
      start: { dateTime: "2026-10-20T10:00:00+02:00" },
      end: { dateTime: "2026-10-20T11:00:00+02:00" },
    },
    {
      id: "utc",
      start: { dateTime: "2026-10-21T09:00:00Z" },
      end: { dateTime: "2026-10-21T10:00:00Z" },
    },
  ];
  const paris = [
    ["day", "2026-10-19T22:00:00.000Z", "2026-10-20T22:00:00.000Z", true],
    ["offset", "2026-10-20T08:00:00.000Z", "2026-10-20T09:00:00.000Z", false],
    ["utc", "2026-10-21T09:00:00.000Z", "2026-10-21T10:00:00.000Z", false],
    ["multi", "2026-10-23T22:00:00.000Z", "2026-11-02T23:00:00.000Z", true],
  ];
  const newYork = [
    ["day", "2026-10-20T04:00:00.000Z", "2026-10-21T04:00:00.000Z", true],
    ["offset", "2026-10-20T08:00:00.000Z", "2026-10-20T09:00:00.000Z", false],
    ["utc", "2026-10-21T09:00:00.000Z", "2026-10-21T10:00:00.000Z", false],
    ["multi", "2026-10-24T04:00:00.000Z", "2026-11-03T05:00:00.000Z", true],
  ];

  it("Paris → New York → Paris: invalidated, then re-projected by a full sync with a new generation", async () => {
    const c = await calendar({
      businessZone: "UTC",
      calendarZone: "Europe/Paris",
    });
    const first = await fullSync(c, "Europe/Paris", events);
    expect(await busy(c)).toEqual(paris);

    // An incremental page reports New York: nothing applied, cursor dropped.
    expect(await apply(c, [], "America/New_York")).toEqual({
      applied: false,
      reason: "timezone_changed",
    });
    expect(await state(c)).toMatchObject({
      timezone: "America/New_York",
      sync_status: "stale",
      sync_token: null,
      full_generation: null,
    });
    // Re-projected in the same transaction: the new zone blocks at once.
    expect(await busy(c)).toEqual(newYork);

    const second = await fullSync(c, "America/New_York", events);
    expect(second).toBeGreaterThan(first);
    expect(await busy(c)).toEqual(newYork);

    // A page of the running full sync seeing another zone stops it too.
    const { rows } = await db.query<{ start: { generation: number } }>(
      "select public.calendar_start_full_sync($1, $2) as start",
      [c.calendarId, c.claimId],
    );
    const stopped = await db.query<{ result: { reason: string } }>(
      "select public.calendar_apply_events($1, $2, $3, 'Europe/Paris', '[]'::jsonb) as result",
      [c.calendarId, c.claimId, rows[0]!.start.generation],
    );
    expect(stopped.rows[0]!.result.reason).toBe("timezone_changed");
    expect(await busy(c)).toEqual(paris);
    const third = await fullSync(c, "Europe/Paris", events);
    expect(third).toBeGreaterThan(rows[0]!.start.generation);
    expect(await busy(c)).toEqual(paris);
  });

  it("an unchanged or unknown zone changes nothing", async () => {
    const c = await calendar({
      businessZone: "UTC",
      calendarZone: "Europe/Paris",
    });
    await fullSync(c, "Europe/Paris", events);
    expect((await apply(c, [], "Europe/Paris")).applied).toBe(true);
    expect((await apply(c, [], "Mars/Olympus")).applied).toBe(true);
    expect(await state(c)).toMatchObject({
      timezone: "Europe/Paris",
      sync_token: "sync-x",
    });
    expect(await busy(c)).toEqual(paris);
  });
});

describe("no under-blocking while a time zone change is being resynced", () => {
  // The full sync confirming a zone change runs after the change is known:
  // meanwhile (status stale) the busy periods must already be those of the
  // new zone. Business in UTC, open around the clock, 60-minute service.
  async function fullSyncIn(c: Calendar, zone: string, events: unknown[]) {
    const { rows } = await db.query<{ start: { generation: number } }>(
      "select public.calendar_start_full_sync($1, $2) as start",
      [c.calendarId, c.claimId],
    );
    const generation = rows[0]!.start.generation;
    await db.query(
      `update private.external_calendar_sync
       set full_window_start = '2010-01-01T00:00Z', full_window_end = '2030-01-01T00:00Z'
       where calendar_id = $1`,
      [c.calendarId],
    );
    await db.query(
      "select public.calendar_apply_events($1, $2, $3, $4, $5::jsonb)",
      [c.calendarId, c.claimId, generation, zone, JSON.stringify(events)],
    );
    await db.query(
      "select public.calendar_finish_full_sync($1, $2, $3, 'sync-x')",
      [c.calendarId, c.claimId, generation],
    );
  }

  async function slug(c: Calendar) {
    const { rows } = await db.query<{ slug: string }>(
      "select slug from public.businesses where id = $1",
      [c.businessId],
    );
    return rows[0]!.slug;
  }

  const book = async (c: Calendar, startsAt: string) =>
    outcome(
      db.query(
        `select * from private.create_public_booking_at($1::timestamptz, $2, $3, $4::timestamptz, 'Cliente', $5)`,
        [NOW, await slug(c), c.serviceId, startsAt, `${randomUUID()}@x.test`],
      ),
    );

  /** Changes the calendar zone through the calendar list (refresh). */
  async function listReportsZone(c: Calendar, zone: string) {
    const { rows } = await db.query<{ saved: boolean }>(
      `select public.calendar_save_calendars(k.id, k.credential_generation,
                jsonb_build_array(jsonb_build_object('id', 'cal', 'name', 'Travail', 'timezone', $2::text))) as saved
       from public.calendar_connections k
       join public.external_calendars c on c.connection_id = k.id
       where c.id = $1`,
      [c.calendarId, zone],
    );
    expect(rows[0]!.saved).toBe(true);
  }

  const events = [
    allDay("day", "2026-10-02", "2026-10-03"),
    {
      id: "offset",
      start: { dateTime: "2026-10-04T10:00:00+02:00" },
      end: { dateTime: "2026-10-04T11:00:00+02:00" },
    },
  ];
  const offsetRow = [
    "offset",
    "2026-10-04T08:00:00.000Z",
    "2026-10-04T09:00:00.000Z",
    false,
  ];

  it("Paris → New York seen in an events page: 03/10 01:00Z is blocked and refused before the resync ends", async () => {
    const c = await calendar({
      businessZone: "UTC",
      calendarZone: "Europe/Paris",
    });
    await fullSyncIn(c, "Europe/Paris", events);
    expect(await busy(c)).toEqual([
      ["day", "2026-10-01T22:00:00.000Z", "2026-10-02T22:00:00.000Z", true],
      offsetRow,
    ]);
    // Free under the Paris reading.
    expect(await slots(c, "2026-10-03")).toContain("2026-10-03T01:00:00.000Z");

    expect(await apply(c, [], "America/New_York")).toEqual({
      applied: false,
      reason: "timezone_changed",
    });

    // Stale, full sync not done yet: the New York reading already blocks.
    const { rows } = await db.query(
      "select sync_status from public.external_calendars where id = $1",
      [c.calendarId],
    );
    expect(rows[0].sync_status).toBe("stale");
    expect(await busy(c)).toEqual([
      ["day", "2026-10-02T04:00:00.000Z", "2026-10-03T04:00:00.000Z", true],
      offsetRow,
    ]);
    expect(await slots(c, "2026-10-03")).not.toContain(
      "2026-10-03T01:00:00.000Z",
    );
    expect(await slots(c, "2026-10-02")).not.toContain(
      "2026-10-02T23:00:00.000Z",
    );
    expect(await book(c, "2026-10-03T01:00:00Z")).toBe("slot_unavailable");
    expect(await book(c, "2026-10-02T22:00:00Z")).toBe("slot_unavailable");

    // The confirming full sync changes nothing.
    await fullSyncIn(c, "America/New_York", events);
    expect(await busy(c)).toEqual([
      ["day", "2026-10-02T04:00:00.000Z", "2026-10-03T04:00:00.000Z", true],
      offsetRow,
    ]);
  });

  it("New York → Paris seen in the calendar list: 02/10 01:00Z is blocked and refused before the resync ends", async () => {
    const c = await calendar({
      businessZone: "UTC",
      calendarZone: "America/New_York",
    });
    await fullSyncIn(c, "America/New_York", events);
    expect(await slots(c, "2026-10-02")).toContain("2026-10-02T01:00:00.000Z");

    await listReportsZone(c, "Europe/Paris");

    expect(await busy(c)).toEqual([
      ["day", "2026-10-01T22:00:00.000Z", "2026-10-02T22:00:00.000Z", true],
      offsetRow,
    ]);
    expect(await slots(c, "2026-10-02")).not.toContain(
      "2026-10-02T01:00:00.000Z",
    );
    expect(await slots(c, "2026-10-01")).not.toContain(
      "2026-10-01T23:00:00.000Z",
    );
    expect(await book(c, "2026-10-02T01:00:00Z")).toBe("slot_unavailable");
    expect(await book(c, "2026-10-01T22:00:00Z")).toBe("slot_unavailable");
    // The sync was invalidated: a full sync (new generation) will confirm.
    const { rows } = await db.query(
      `select c.sync_status, s.sync_token from public.external_calendars c
       join private.external_calendar_sync s on s.calendar_id = c.id where c.id = $1`,
      [c.calendarId],
    );
    expect(rows[0]).toEqual({ sync_status: "stale", sync_token: null });
  });

  it("multi-day all-day events across DST and events with their own zone", async () => {
    const c = await calendar({
      businessZone: "UTC",
      calendarZone: "Europe/Paris",
    });
    await fullSyncIn(c, "Europe/Paris", [
      allDay("multi", "2026-10-24", "2026-11-03"),
      allDay("tokyo", "2026-10-10", "2026-10-11", {
        start: { date: "2026-10-10", timeZone: "Asia/Tokyo" },
      }),
    ]);
    await listReportsZone(c, "America/New_York");
    expect(await busy(c)).toEqual([
      // Its own zone: unchanged.
      ["tokyo", "2026-10-09T15:00:00.000Z", "2026-10-10T15:00:00.000Z", true],
      ["multi", "2026-10-24T04:00:00.000Z", "2026-11-03T05:00:00.000Z", true],
    ]);
  });

  it("a booking waiting on the zone change transaction sees the new projection (two real transactions)", async () => {
    const c = await calendar({
      businessZone: "UTC",
      calendarZone: "Europe/Paris",
    });
    await fullSyncIn(c, "Europe/Paris", events);

    const change = await openTransaction();
    await change.connection.query(
      `select public.calendar_save_calendars(k.id, k.credential_generation,
                jsonb_build_array(jsonb_build_object('id', 'cal', 'name', 'Travail', 'timezone', 'America/New_York')))
       from public.calendar_connections k
       join public.external_calendars c on c.connection_id = k.id
       where c.id = $1`,
      [c.calendarId],
    );

    const booking = await openTransaction();
    const pending = outcome(
      booking.connection.query(
        `select * from private.create_public_booking_at($1::timestamptz, $2, $3, '2026-10-03T01:00:00Z'::timestamptz, 'Cliente', $4)`,
        [NOW, await slug(c), c.serviceId, `${randomUUID()}@x.test`],
      ),
    );
    await waitUntilBlocked(booking.pid);
    await closeTransaction(change, "commit");

    expect(await pending).toBe("slot_unavailable");
    await closeTransaction(booking, "rollback");
  });
});
