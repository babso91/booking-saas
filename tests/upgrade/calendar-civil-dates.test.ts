import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createProfessional,
  db,
} from "../integration/support/fixtures";

// Upgrade of a populated database (not a fresh install): busy periods
// stored before civil dates existed (20261005090000) must survive the
// migration chain exactly, and only a full sync from Google may replace
// them with canonical rows. Historical rows are inserted at the schema of
// 20261004090000, as the code of that time stored them (UTC bounds only).

type Case = {
  key: string;
  calendarZone: string;
  /** The event as Google describes it (what the full sync will return). */
  event: { id: string; start: object; end: object };
  /** The UTC window stored before the upgrade. */
  stored: [string, string];
  /** Canonical result after the full sync. */
  canonical: { dates: [string, string]; zone: string | null };
};

const cases: Case[] = [
  {
    // Codex's case: the event has its own zone (Paris, 23-hour day), the
    // calendar is in Lagos. Rebuilding the dates in Lagos gives 28 → 28.
    key: "lagos",
    calendarZone: "Africa/Lagos",
    event: {
      id: "spring-own-zone",
      start: { date: "2027-03-28", timeZone: "Europe/Paris" },
      end: { date: "2027-03-29", timeZone: "Europe/Paris" },
    },
    stored: ["2027-03-27T23:00:00.000Z", "2027-03-28T22:00:00.000Z"],
    canonical: { dates: ["2027-03-28", "2027-03-29"], zone: "Europe/Paris" },
  },
  {
    key: "paris-23h",
    calendarZone: "Europe/Paris",
    event: {
      id: "spring",
      start: { date: "2027-03-28" },
      end: { date: "2027-03-29" },
    },
    stored: ["2027-03-27T23:00:00.000Z", "2027-03-28T22:00:00.000Z"],
    canonical: { dates: ["2027-03-28", "2027-03-29"], zone: null },
  },
  {
    key: "paris-25h",
    calendarZone: "Europe/Paris",
    event: {
      id: "autumn",
      start: { date: "2026-10-25" },
      end: { date: "2026-10-26" },
    },
    stored: ["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
    canonical: { dates: ["2026-10-25", "2026-10-26"], zone: null },
  },
  {
    key: "havana",
    calendarZone: "America/Havana",
    event: {
      id: "havana",
      start: { date: "2026-11-01" },
      end: { date: "2026-11-02" },
    },
    stored: ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    canonical: { dates: ["2026-11-01", "2026-11-02"], zone: null },
  },
];

let businessId: string;
let connectionId: string;
const calendarIds = new Map<string, string>();

const iso = (value: Date) => value.toISOString();

async function rows(calendarId: string) {
  const { rows: found } = await db.query<{
    provider_event_id: string;
    starts_at: Date;
    ends_at: Date;
    all_day: boolean;
    all_day_start_date: string | null;
    all_day_end_date: string | null;
    all_day_zone: string | null;
    approximate: boolean;
  }>(
    `select provider_event_id, starts_at, ends_at, all_day,
            all_day_start_date::text, all_day_end_date::text, all_day_zone,
            approximate
     from public.external_calendar_events
     where external_calendar_id = $1 order by starts_at`,
    [calendarId],
  );
  return found;
}

/** A full sync as the server runs it, with the provider's answer. */
async function fullSync(calendarId: string, zone: string, events: unknown[]) {
  const { rows: claimed } = await db.query<{
    claim: { claimed: boolean; claimId: string };
  }>("select public.calendar_claim_sync($1) as claim", [calendarId]);
  const claimId = claimed[0]!.claim.claimId;
  const { rows: started } = await db.query<{ start: { generation: number } }>(
    "select public.calendar_start_full_sync($1, $2) as start",
    [calendarId, claimId],
  );
  const generation = started[0]!.start.generation;
  await db.query(
    `update private.external_calendar_sync
     set full_window_start = '2026-01-01T00:00Z', full_window_end = '2028-01-01T00:00Z'
     where calendar_id = $1`,
    [calendarId],
  );
  await db.query(
    "select public.calendar_apply_events($1, $2, $3, $4, $5::jsonb)",
    [calendarId, claimId, generation, zone, JSON.stringify(events)],
  );
  await db.query(
    "select public.calendar_finish_full_sync($1, $2, $3, 'sync-new')",
    [calendarId, claimId, generation],
  );
  await db.query("select public.calendar_release_sync($1, $2, 'synced')", [
    calendarId,
    claimId,
  ]);
}

beforeAll(async () => {
  // Historical data, at the schema of 20261004090000.
  const owner = await createProfessional("upgrade");
  const business = await createBusiness(owner.userId, {
    timezone: "Europe/Paris",
  });
  businessId = business.id;
  const { rows: connection } = await db.query<{ id: string }>(
    `insert into public.calendar_connections (business_id, provider, provider_account_id, account_email)
     values ($1, 'google', $2, 'x@gmail.test') returning id`,
    [businessId, `sub-${randomUUID()}`],
  );
  connectionId = connection[0]!.id;

  for (const item of cases) {
    const { rows: calendar } = await db.query<{ id: string }>(
      `insert into public.external_calendars
         (business_id, connection_id, provider_calendar_id, name, timezone, selected_for_blocking, sync_status)
       values ($1, $2, $3, $3, $4, true, 'synced') returning id`,
      [businessId, connectionId, `cal-${item.key}`, item.calendarZone],
    );
    const calendarId = calendar[0]!.id;
    calendarIds.set(item.key, calendarId);
    await db.query(
      `insert into private.external_calendar_sync
         (calendar_id, generation, allocated_generation, sync_token, window_start, window_end)
       values ($1, 1, 1, 'sync-old', '2026-01-01T00:00Z', '2028-01-01T00:00Z')`,
      [calendarId],
    );
    // A single all-day row per calendar (the "only all-day row" case).
    await db.query(
      `insert into public.external_calendar_events
         (business_id, external_calendar_id, provider_event_id, starts_at, ends_at, all_day, busy, sync_generation)
       values ($1, $2, $3, $4, $5, true, true, 1)`,
      [businessId, calendarId, item.event.id, ...item.stored],
    );
  }
  // A timed event next to an all-day one: never touched by the backfill.
  await db.query(
    `insert into public.external_calendar_events
       (business_id, external_calendar_id, provider_event_id, starts_at, ends_at, all_day, busy, sync_generation)
     values ($1, $2, 'timed', '2026-10-20T08:00Z', '2026-10-20T09:00Z', false, true, 1)`,
    [businessId, calendarIds.get("paris-25h")],
  );

  // Then the rest of the migration chain, as a deployment applies it.
  execFileSync("npx", ["supabase", "migration", "up", "--local"], {
    stdio: "inherit",
  });
});

describe("upgrading a database holding all-day busy periods", () => {
  it("keeps every historical UTC busy window exactly, civil dates unknown", async () => {
    for (const item of cases) {
      const found = await rows(calendarIds.get(item.key)!);
      const allDay = found.filter((row) => row.all_day);
      expect(
        allDay.map((row) => [iso(row.starts_at), iso(row.ends_at)]),
      ).toEqual([item.stored]);
      expect(allDay[0]).toMatchObject({
        all_day_start_date: null,
        all_day_end_date: null,
        all_day_zone: null,
        // Civil dates unknown: the period counts as approximate.
        approximate: true,
      });
    }
    // Availability still sees them as busy.
    const { rows: busy } = await db.query<{ busy: string }>(
      `select private.external_busy($1, '2027-03-27T00:00Z', '2027-03-29T00:00Z')::text as busy`,
      [businessId],
    );
    expect(busy[0]!.busy).toBe(
      '{["2027-03-27 23:00:00+00","2027-03-28 22:00:00+00")}',
    );
    const timed = (await rows(calendarIds.get("paris-25h")!)).find(
      (row) => row.provider_event_id === "timed",
    )!;
    expect([iso(timed.starts_at), iso(timed.ends_at)]).toEqual([
      "2026-10-20T08:00:00.000Z",
      "2026-10-20T09:00:00.000Z",
    ]);
    expect(timed.approximate).toBe(false);
  });

  it("forces a full sync of every calendar holding one, even a single row", async () => {
    const { rows: states } = await db.query(
      `select c.provider_calendar_id, c.sync_status, s.sync_token, s.full_generation
       from public.external_calendars c
       join private.external_calendar_sync s on s.calendar_id = c.id
       where c.business_id = $1 order by 1`,
      [businessId],
    );
    expect(states).toEqual(
      cases
        .map((item) => ({
          provider_calendar_id: `cal-${item.key}`,
          sync_status: "stale",
          sync_token: null,
          full_generation: null,
        }))
        .sort((a, b) =>
          a.provider_calendar_id.localeCompare(b.provider_calendar_id),
        ),
    );
  });

  it("a calendar zone change before the resync widens legacy rows (never narrows them)", async () => {
    const { rows: generation } = await db.query<{ g: string }>(
      "select credential_generation as g from public.calendar_connections where id = $1",
      [connectionId],
    );
    await db.query("select public.calendar_save_calendars($1, $2, $3::jsonb)", [
      connectionId,
      generation[0]!.g,
      JSON.stringify(
        cases.map((item) => ({
          id: `cal-${item.key}`,
          name: `cal-${item.key}`,
          timezone:
            item.key === "paris-25h" ? "America/New_York" : item.calendarZone,
          accessRole: "owner",
        })),
      ),
    ]);
    const legacy = (await rows(calendarIds.get("paris-25h")!)).find(
      (row) => row.all_day,
    )!;
    // Stored 24 Oct 22:00Z → 25 Oct 23:00Z, widened by 26 h each side; the
    // New York projection (25 Oct 04:00Z → 26 Oct 04:00Z) lies inside.
    expect([iso(legacy.starts_at), iso(legacy.ends_at)]).toEqual([
      "2026-10-23T20:00:00.000Z",
      "2026-10-27T01:00:00.000Z",
    ]);
  });

  it("only the full sync from Google makes the rows canonical", async () => {
    for (const item of cases) {
      const zone =
        item.key === "paris-25h" ? "America/New_York" : item.calendarZone;
      await fullSync(calendarIds.get(item.key)!, zone, [
        { ...item.event, status: "confirmed" },
      ]);
      const allDay = (await rows(calendarIds.get(item.key)!)).filter(
        (row) => row.all_day,
      );
      expect(allDay).toHaveLength(1);
      expect(allDay[0]).toMatchObject({
        provider_event_id: item.event.id,
        all_day_start_date: item.canonical.dates[0],
        all_day_end_date: item.canonical.dates[1],
        all_day_zone: item.canonical.zone,
        approximate: false,
      });
      const expected =
        item.key === "paris-25h"
          ? ["2026-10-25T04:00:00.000Z", "2026-10-26T04:00:00.000Z"]
          : item.stored;
      expect([iso(allDay[0]!.starts_at), iso(allDay[0]!.ends_at)]).toEqual(
        expected,
      );
    }
    const { rows: states } = await db.query(
      `select distinct c.sync_status from public.external_calendars c where c.business_id = $1`,
      [businessId],
    );
    expect(states).toEqual([{ sync_status: "synced" }]);
  });
});
