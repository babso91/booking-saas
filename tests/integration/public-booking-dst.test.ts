import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildAxis, placeAppointments } from "@/features/agenda/client/layout";
import { wallOf, zoneOf } from "@/features/agenda/client/zone";
import { getAgenda } from "@/features/agenda/data/agenda";
import { createManualAppointment } from "@/features/agenda/data/appointments";
import { createBlock } from "@/features/agenda/data/blocks";
import { startOfLocalDate, utcToZonedLocal } from "@/lib/time/zoned";

import {
  addException,
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  setWeeklyHours,
  type BusinessSettings,
} from "./support/fixtures";

// PostgreSQL is the calendar authority: public availability, booking and
// the agenda use the same civil day, D = [first real instant of D, first
// real instant of D + 1), and the same wall-clock policy for weekly hours.
// Critical expectations are explicit UTC instants. Every date-dependent rule
// runs with an explicit "now" (private.available_slots,
// private.create_public_booking_at): the date of the run never matters.

const HOUR = 3_600_000;
const HAVANA = "America/Havana";
// 2026-11-01: 00:59 CDT → 00:00 CST at 05:00Z. Midnight at 04:00Z and 05:00Z.
const REPEATED = "2026-11-01";
const ALL_DAY: [string, string] = ["00:00", "24:00"];

type Setup = {
  businessId: string;
  slug: string;
  timezone: string;
  serviceId: string;
  ownerClient: Awaited<ReturnType<typeof createProfessional>>["client"];
};

async function setup(
  timezone: string,
  options: {
    durationMinutes?: number;
    settings?: BusinessSettings;
    hours?: [number, string, string][];
  } = {},
): Promise<Setup> {
  const owner = await createProfessional("public-dst");
  const business = await createBusiness(owner.userId, {
    timezone,
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
      ...options.settings,
    },
  });
  const serviceId = await createService(business.id, {
    durationMinutes: options.durationMinutes ?? 30,
  });
  await setWeeklyHours(
    business.id,
    options.hours ??
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => [weekday, ...ALL_DAY]),
  );

  return {
    businessId: business.id,
    slug: business.slug,
    timezone,
    serviceId,
    ownerClient: owner.client,
  };
}

/** A fixed "now", well before every date tested. */
const NOW = "2026-09-01T00:00:00Z";

/** private.available_slots with an explicit "now", as UTC ISO strings. */
async function slots(s: Setup, date: string, now = NOW) {
  const { rows } = await db.query<{ starts_at: Date; ends_at: Date }>(
    `select starts_at, ends_at
     from private.available_slots($1, $2, $3::date, $4::timestamptz)`,
    [s.businessId, s.serviceId, date, now],
  );
  return rows.map((row) => ({
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  }));
}

const starts = (list: { startsAt: string }[]) =>
  list.map((slot) => slot.startsAt);

/**
 * The booking transaction of public.create_public_booking, with an explicit
 * "now" (the public RPC passes now()). Resolves to the booked start, or
 * rejects with the error code (`slot_unavailable`…).
 */
async function book(s: Setup, startsAt: string, now = NOW): Promise<string> {
  const { rows } = await db.query<{ starts_at: Date }>(
    `select starts_at
     from private.create_public_booking_at($1::timestamptz, $2, $3::uuid,
       $4::timestamptz, 'Cliente', $5)`,
    [now, s.slug, s.serviceId, startsAt, `${randomUUID()}@x.test`],
  );
  return rows[0]!.starts_at.toISOString();
}

/** Real opening ranges of a date (private.opening_ranges), as UTC pairs. */
async function openRanges(s: Setup, date: string) {
  const { rows } = await db.query<{ lo: Date; hi: Date }>(
    `select lower(r) as lo, upper(r) as hi
     from unnest(coalesce(private.opening_ranges($1, $2::date, $3),
                          '{}'::tstzmultirange)) r
     order by 1`,
    [s.businessId, date, s.timezone],
  );
  return rows.map((row) => [row.lo.toISOString(), row.hi.toISOString()]);
}

/** Wall clocks read by PostgreSQL. */
async function pgWalls(instants: string[], timezone: string) {
  const { rows } = await db.query<{ wall: string }>(
    `select private.wall_clock(t, $2) as wall
     from unnest($1::timestamptz[]) with ordinality as u(t, n) order by n`,
    [instants, timezone],
  );
  return rows.map((row) => row.wall);
}

async function appointmentCount(s: Setup) {
  const { rows } = await db.query<{ count: number }>(
    "select count(*)::int as count from public.appointments where business_id = $1",
    [s.businessId],
  );
  return rows[0]!.count;
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("Havana, repeated midnight (2026-11-01)", () => {
  it("lists both 00:30 occurrences under 1 November, none under 31 October", async () => {
    const s = await setup(HAVANA);

    const nov1 = await slots(s, REPEATED);
    const oct31 = await slots(s, "2026-10-31");

    // 25 real hours of 30-minute slots, from the first midnight.
    expect(nov1).toHaveLength(50);
    expect(nov1[0]).toEqual({
      startsAt: "2026-11-01T04:00:00.000Z",
      endsAt: "2026-11-01T04:30:00.000Z",
    });
    expect(starts(nov1)).toContain("2026-11-01T04:30:00.000Z"); // 00:30 (1st)
    expect(starts(nov1)).toContain("2026-11-01T05:30:00.000Z"); // 00:30 (2nd)
    expect(nov1.at(-1)!.endsAt).toBe("2026-11-02T05:00:00.000Z");

    // 31 October ends where 1 November really begins.
    expect(oct31).toHaveLength(48);
    expect(oct31.at(-1)).toEqual({
      startsAt: "2026-11-01T03:30:00.000Z",
      endsAt: "2026-11-01T04:00:00.000Z",
    });
    expect(
      oct31.some((slot) => slot.startsAt >= "2026-11-01T04:00:00.000Z"),
    ).toBe(false);
  });

  it("never lists a slot twice or under the wrong date, around the change", async () => {
    const s = await setup(HAVANA);
    const days = ["2026-10-31", REPEATED, "2026-11-02"];
    const all: string[] = [];

    for (const date of days) {
      const list = await slots(s, date);
      const { rows } = await db.query<{ day: string }>(
        `select to_char(private.local_date_of(t, $2), 'YYYY-MM-DD') as day
         from unnest($1::timestamptz[]) t`,
        [starts(list), HAVANA],
      );
      // Each slot belongs to the civil day of its real instant.
      expect(new Set(rows.map((row) => row.day))).toEqual(new Set([date]));
      for (const slot of list) {
        expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(
          HOUR / 2,
        );
        all.push(slot.startsAt);
      }
    }

    // Consecutive half-open slots tile the 3 days exactly: 24 + 25 + 24 h.
    expect(all).toHaveLength(48 + 50 + 48);
    expect(new Set(all).size).toBe(all.length);
    all.forEach((startsAt, index) => {
      if (index > 0) {
        expect(Date.parse(startsAt) - Date.parse(all[index - 1]!)).toBe(
          HOUR / 2,
        );
      }
    });
  });

  it("removes both occurrences under a whole-day closure", async () => {
    const s = await setup(HAVANA);
    const block = await createBlock(
      s.ownerClient,
      { businessId: s.businessId, timezone: HAVANA },
      { allDay: true, startDate: REPEATED, endDate: REPEATED, reason: null },
    );
    // Non-regression of #7: the real 25-hour day.
    expect([block.startsAt, block.endsAt]).toEqual([
      "2026-11-01T04:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
    ]);

    expect(await slots(s, REPEATED)).toEqual([]);
    // The day before is untouched, and does not leak into the closure.
    const oct31 = await slots(s, "2026-10-31");
    expect(oct31).toHaveLength(48);
    expect(oct31.at(-1)!.endsAt).toBe("2026-11-01T04:00:00.000Z");
    expect((await slots(s, "2026-11-02"))[0]!.startsAt).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });

  it("opens 00:00 → 24:00 as the whole real day; 24:00 is where the next day begins", async () => {
    // Saturday 31 Oct 20:00 → 24:00 must stop at the FIRST midnight.
    const s = await setup(HAVANA, { hours: [[6, "20:00", "24:00"]] });

    expect(starts(await slots(s, "2026-10-31"))).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-11-01T00:30:00.000Z",
      "2026-11-01T01:00:00.000Z",
      "2026-11-01T01:30:00.000Z",
      "2026-11-01T02:00:00.000Z",
      "2026-11-01T02:30:00.000Z",
      "2026-11-01T03:00:00.000Z",
      "2026-11-01T03:30:00.000Z",
    ]);
  });

  it("starts 00:00 → 02:00 at the first midnight and spans 3 real hours", async () => {
    const s = await setup(HAVANA, { hours: [[0, "00:00", "02:00"]] });

    const nov1 = await slots(s, REPEATED);
    expect(nov1[0]!.startsAt).toBe("2026-11-01T04:00:00.000Z");
    expect(nov1.at(-1)!.endsAt).toBe("2026-11-01T07:00:00.000Z");
    expect(nov1).toHaveLength(6);
  });

  it("skipped midnight (2027-03-14): a 23-hour day starting after the gap", async () => {
    const s = await setup(HAVANA);

    const day = await slots(s, "2027-03-14");
    expect(day).toHaveLength(46);
    expect(day[0]!.startsAt).toBe("2027-03-14T05:00:00.000Z");
    expect(day.at(-1)!.endsAt).toBe("2027-03-15T04:00:00.000Z");
    expect((await slots(s, "2027-03-13")).at(-1)!.endsAt).toBe(
      "2027-03-14T05:00:00.000Z",
    );
  });

  it("filters hourly blocks and appointments with half-open bounds", async () => {
    const s = await setup(HAVANA);
    // Block 31 Oct 23:00 → 1 Nov first 00:30.
    await addException(
      s.businessId,
      "blocked",
      "2026-11-01T03:00:00Z",
      "2026-11-01T04:30:00Z",
    );
    const client = await createClientRecord(s.businessId, "c@x.test");
    // Appointment on the second 00:30.
    await insertAppointment({
      businessId: s.businessId,
      clientId: client,
      serviceId: s.serviceId,
      startsAt: "2026-11-01T05:30:00Z",
      endsAt: "2026-11-01T06:00:00Z",
    });

    const nov1 = starts(await slots(s, REPEATED));
    expect(nov1).not.toContain("2026-11-01T04:00:00.000Z");
    expect(nov1[0]).toBe("2026-11-01T04:30:00.000Z"); // block ends exactly here
    expect(nov1).toContain("2026-11-01T05:00:00.000Z"); // ends where it starts
    expect(nov1).not.toContain("2026-11-01T05:30:00.000Z");
    expect(nov1).toContain("2026-11-01T06:00:00.000Z");
    expect(starts(await slots(s, "2026-10-31")).at(-1)).toBe(
      "2026-11-01T02:30:00.000Z",
    );
  });

  it("keeps completed and no-show appointments occupying, releases cancelled ones", async () => {
    const s = await setup(HAVANA);
    const client = await createClientRecord(s.businessId, "o@x.test");
    for (const [startsAt, status] of [
      ["2026-11-01T04:30:00Z", "completed"],
      ["2026-11-01T05:00:00Z", "no_show"],
      ["2026-11-01T05:30:00Z", "cancelled"],
    ] as const) {
      await insertAppointment({
        businessId: s.businessId,
        clientId: client,
        serviceId: s.serviceId,
        startsAt,
        endsAt: iso(Date.parse(startsAt) + HOUR / 2),
        status,
      });
    }

    const nov1 = starts(await slots(s, REPEATED));
    expect(nov1).not.toContain("2026-11-01T04:30:00.000Z");
    expect(nov1).not.toContain("2026-11-01T05:00:00.000Z");
    expect(nov1).toContain("2026-11-01T05:30:00.000Z");
  });

  it("counts service and buffer in real minutes across the repeated hour", async () => {
    const s = await setup(HAVANA, {
      durationMinutes: 60,
      settings: { slot_interval_minutes: 15, buffer_minutes: 15 },
    });
    const client = await createClientRecord(s.businessId, "b@x.test");
    // First 00:30 → second 00:30 (60 real minutes), + 15 min buffer.
    await insertAppointment({
      businessId: s.businessId,
      clientId: client,
      serviceId: s.serviceId,
      startsAt: "2026-11-01T04:30:00Z",
      endsAt: "2026-11-01T05:30:00Z",
      bufferMinutes: 15,
    });

    const nov1 = await slots(s, REPEATED);
    for (const slot of nov1) {
      expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(HOUR);
    }
    // The next start is 05:45Z: 60 + 15 real minutes after 04:30Z.
    expect(
      starts(nov1).filter((value) => value < "2026-11-01T06:00:00.000Z"),
    ).toEqual(["2026-11-01T05:45:00.000Z"]);
  });

  it("applies the minimum notice in real minutes across the change", async () => {
    const s = await setup(HAVANA, {
      settings: { minimum_booking_notice_minutes: 60 },
    });

    // now = first 00:50 (04:50Z): earliest start 05:50Z, i.e. second 00:50.
    expect(starts(await slots(s, REPEATED, "2026-11-01T04:50:00Z"))[0]).toBe(
      "2026-11-01T06:00:00.000Z",
    );
  });

  it("ends the horizon where the day after the last bookable day begins", async () => {
    // Today = 30 Oct, 1 day ahead: 31 Oct is the last day, entirely.
    const s = await setup(HAVANA, {
      settings: { maximum_booking_advance_days: 1 },
    });
    const now = "2026-10-30T16:00:00Z";

    const oct31 = await slots(s, "2026-10-31", now);
    expect(oct31).toHaveLength(48);
    expect(oct31.at(-1)!.endsAt).toBe("2026-11-01T04:00:00.000Z");
    // The first real hour of 1 November is beyond the horizon too.
    expect(await slots(s, REPEATED, now)).toEqual([]);
  });
});

describe("booking validates exactly what is listed (fixed now, production core)", () => {
  // Several "now" before the change: the outcome never depends on the date
  // of the run (31/10/2026, 06/11/2026, 2027… all give the same answers).
  const NOWS = [NOW, "2026-10-31T12:00:00Z", "2026-11-01T03:59:00Z"] as const;

  it.each(NOWS)(
    "now = %s: both 00:30 occurrences are listed and bookable",
    async (now) => {
      const s = await setup(HAVANA);
      const listed = starts(await slots(s, REPEATED, now));
      const targets = [
        "2026-11-01T04:00:00.000Z", // first midnight
        "2026-11-01T04:30:00.000Z", // 00:30, first occurrence
        "2026-11-01T05:30:00.000Z", // 00:30, second occurrence
      ];
      expect(listed[0]).toBe(targets[0]);
      expect(listed).toEqual(expect.arrayContaining(targets));
      expect(
        starts(await slots(s, "2026-10-31", now)).every(
          (value) => value < targets[0]!,
        ),
      ).toBe(true);

      for (const startsAt of targets) {
        await expect(book(s, startsAt, now)).resolves.toBe(startsAt);
      }
      expect(await appointmentCount(s)).toBe(3);
    },
  );

  it.each(NOWS)(
    "now = %s: under a whole-day closure nothing is listed nor bookable",
    async (now) => {
      const s = await setup(HAVANA);
      await createBlock(
        s.ownerClient,
        { businessId: s.businessId, timezone: HAVANA },
        { allDay: true, startDate: REPEATED, endDate: REPEATED, reason: null },
      );

      expect(await slots(s, REPEATED, now)).toEqual([]);
      for (const startsAt of [
        "2026-11-01T04:00:00.000Z",
        "2026-11-01T04:30:00.000Z",
        "2026-11-01T05:30:00.000Z",
        "2026-11-02T04:30:00.000Z", // last real minutes of the 25-hour day
      ]) {
        await expect(book(s, startsAt, now)).rejects.toMatchObject({
          message: "slot_unavailable",
        });
      }
      expect(await appointmentCount(s)).toBe(0);
    },
  );

  it("a now past the slot refuses it, in the listing and in the booking", async () => {
    const s = await setup(HAVANA);
    const later = "2026-11-01T05:00:00Z"; // second midnight

    expect(starts(await slots(s, REPEATED, later))[0]).toBe(
      "2026-11-01T05:00:00.000Z",
    );
    await expect(
      book(s, "2026-11-01T04:30:00.000Z", later),
    ).rejects.toMatchObject({ message: "slot_unavailable" });
    await expect(book(s, "2026-11-01T05:00:00.000Z", later)).resolves.toBe(
      "2026-11-01T05:00:00.000Z",
    );
  });

  it("the public RPCs are the private cores called with the database's now", async () => {
    const { rows } = await db.query<{ name: string; body: string }>(
      `select p.proname as name, pg_get_functiondef(p.oid) as body
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('create_public_booking', 'get_available_slots')
       order by 1`,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "create_public_booking",
      "get_available_slots",
    ]);
    expect(rows[0]!.body).toMatch(
      /private\.create_public_booking_at\(\s*pg_catalog\.now\(\)/,
    );
    expect(rows[1]!.body).toMatch(
      /private\.available_slots\([^)]*pg_catalog\.now\(\)\)/,
    );

    // No client can choose its own "now".
    const { rows: grants } = await db.query<{ anon: boolean; auth: boolean }>(
      `select
         has_function_privilege('anon', 'private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text)', 'execute') as anon,
         has_function_privilege('authenticated', 'private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text)', 'execute') as auth`,
    );
    expect(grants[0]).toEqual({ anon: false, auth: false });
  });
});

describe("Havana, weekly ranges in the repeated hour (wall-clock policy)", () => {
  // 1 November 2026 (Sunday): 00:00–01:00 happens twice, 04:00Z–05:00Z (CDT)
  // then 05:00Z–06:00Z (CST). A weekly range is the set of instants of the
  // day whose wall clock is in [from, to): possibly several UTC intervals,
  // never one continuous interval longer than the wall-clock range.
  const cases: {
    hours: [string, string];
    ranges: [string, string][];
    slots: string[];
  }[] = [
    {
      hours: ["00:00", "00:30"],
      ranges: [
        ["2026-11-01T04:00:00.000Z", "2026-11-01T04:30:00.000Z"],
        ["2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z"],
      ],
      slots: ["2026-11-01T04:00:00.000Z", "2026-11-01T05:00:00.000Z"],
    },
    {
      hours: ["00:15", "00:45"],
      ranges: [
        ["2026-11-01T04:15:00.000Z", "2026-11-01T04:45:00.000Z"],
        ["2026-11-01T05:15:00.000Z", "2026-11-01T05:45:00.000Z"],
      ],
      slots: ["2026-11-01T04:15:00.000Z", "2026-11-01T05:15:00.000Z"],
    },
    {
      hours: ["00:30", "01:00"],
      ranges: [
        ["2026-11-01T04:30:00.000Z", "2026-11-01T05:00:00.000Z"],
        ["2026-11-01T05:30:00.000Z", "2026-11-01T06:00:00.000Z"],
      ],
      slots: ["2026-11-01T04:30:00.000Z", "2026-11-01T05:30:00.000Z"],
    },
    {
      // Covers the whole repeated hour: one continuous real interval of 3 h.
      hours: ["00:00", "02:00"],
      ranges: [["2026-11-01T04:00:00.000Z", "2026-11-01T07:00:00.000Z"]],
      slots: [
        "2026-11-01T04:00:00.000Z",
        "2026-11-01T04:30:00.000Z",
        "2026-11-01T05:00:00.000Z",
        "2026-11-01T05:30:00.000Z",
        "2026-11-01T06:00:00.000Z",
        "2026-11-01T06:30:00.000Z",
      ],
    },
  ];

  it.each(cases)(
    "$hours.0 → $hours.1: exact segments, slots, agenda and bookings agree",
    async ({ hours, ranges, slots: expected }) => {
      const s = await setup(HAVANA, { hours: [[0, ...hours]] });

      // Segments (exact UTC, count) and slots.
      expect(await openRanges(s, REPEATED)).toEqual(ranges);
      const listed = await slots(s, REPEATED);
      expect(starts(listed)).toEqual(expected);

      // No opening instant has a wall clock outside [from, to).
      const walls = await pgWalls(
        ranges.flatMap(([lo, hi]) => {
          const minutes: string[] = [];
          for (let t = Date.parse(lo); t < Date.parse(hi); t += 60_000) {
            minutes.push(iso(t));
          }
          return minutes;
        }),
        HAVANA,
      );
      for (const wall of walls) {
        expect(wall.slice(0, 10)).toBe(REPEATED);
        expect(wall.slice(11) >= hours[0] && wall.slice(11) < hours[1]).toBe(
          true,
        );
      }

      // The agenda shows exactly the same ranges.
      const agenda = await getAgenda(
        s.ownerClient,
        { businessId: s.businessId, timezone: HAVANA },
        { startDate: REPEATED, endDate: REPEATED, includeCancelled: false },
      );
      expect(
        agenda.workingHours.days[0]!.openRanges.map((range) => [
          range.startsAt,
          range.endsAt,
        ]),
      ).toEqual(ranges);

      // Every listed slot can be booked; an instant between the segments
      // cannot.
      for (const startsAt of expected) {
        await expect(book(s, startsAt)).resolves.toBe(startsAt);
      }
      if (ranges.length > 1) {
        await expect(book(s, ranges[0]![1])).rejects.toMatchObject({
          message: "slot_unavailable",
        });
      }
    },
  );

  it("a range closing in the first occurrence, another in the second: no gap invented", async () => {
    // Saturday 31 Oct 23:00 → 24:00 then Sunday 00:00 → 00:30: the night of
    // the change, contiguous on the wall clock across the first midnight.
    const s = await setup(HAVANA, {
      hours: [
        [6, "23:00", "24:00"],
        [0, "00:00", "00:30"],
      ],
    });
    expect(await openRanges(s, "2026-10-31")).toEqual([
      ["2026-11-01T03:00:00.000Z", "2026-11-01T04:00:00.000Z"],
    ]);
    expect(await openRanges(s, REPEATED)).toEqual([
      ["2026-11-01T04:00:00.000Z", "2026-11-01T04:30:00.000Z"],
      ["2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z"],
    ]);
  });

  it("a service and its buffer never leave a segment, even across the change", async () => {
    // 60-minute service, 15-minute steps, in 00:00 → 00:30: no segment is
    // long enough, so nothing (never a 60-minute slot across the segments).
    const s = await setup(HAVANA, {
      durationMinutes: 60,
      settings: { slot_interval_minutes: 15, buffer_minutes: 15 },
      hours: [[0, "00:00", "00:30"]],
    });
    expect(await slots(s, REPEATED)).toEqual([]);

    // 00:00 → 02:00 (one 3-hour real interval): a 60-minute slot may cross
    // the change (04:30Z → 05:30Z, first 00:30 → second 00:30).
    const wide = await setup(HAVANA, {
      durationMinutes: 60,
      settings: { slot_interval_minutes: 30, buffer_minutes: 15 },
      hours: [[0, "00:00", "02:00"]],
    });
    expect(starts(await slots(wide, REPEATED))).toContain(
      "2026-11-01T04:30:00.000Z",
    );
    await book(wide, "2026-11-01T04:30:00.000Z");
    // Next start: 60 + 15 real minutes later at the earliest.
    expect(
      starts(await slots(wide, REPEATED)).filter(
        (value) => value > "2026-11-01T04:30:00.000Z",
      )[0],
    ).toBe("2026-11-01T06:00:00.000Z");
  });
});

describe("other irregular days", () => {
  it("Paris: 23-hour and 25-hour days", async () => {
    const s = await setup("Europe/Paris");

    const spring = await slots(s, "2027-03-28");
    expect(spring).toHaveLength(46);
    expect(spring[0]!.startsAt).toBe("2027-03-27T23:00:00.000Z");
    expect(spring.at(-1)!.endsAt).toBe("2027-03-28T22:00:00.000Z");

    const autumn = await slots(s, "2026-10-25");
    expect(autumn).toHaveLength(50);
    expect(autumn[0]!.startsAt).toBe("2026-10-24T22:00:00.000Z");
    expect(autumn.at(-1)!.endsAt).toBe("2026-10-25T23:00:00.000Z");
    // 02:00 and 02:30 twice, as four distinct instants.
    expect(starts(autumn)).toEqual(
      expect.arrayContaining([
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:30:00.000Z",
        "2026-10-25T01:00:00.000Z",
        "2026-10-25T01:30:00.000Z",
      ]),
    );
  });

  it("Lord Howe: 23.5-hour and 24.5-hour days (30-minute transitions)", async () => {
    const s = await setup("Australia/Lord_Howe");

    const spring = await slots(s, "2026-10-04");
    expect(spring).toHaveLength(47);
    expect(spring[0]!.startsAt).toBe("2026-10-03T13:30:00.000Z");
    expect(spring.at(-1)!.endsAt).toBe("2026-10-04T13:00:00.000Z");

    const autumn = await slots(s, "2027-04-04");
    expect(autumn).toHaveLength(49);
  });

  it("Troll: 2-hour transitions (22-hour and 26-hour days)", async () => {
    const s = await setup("Antarctica/Troll");

    expect(await slots(s, "2027-03-28")).toHaveLength(44);
    expect(await slots(s, "2026-10-25")).toHaveLength(52);
  });

  it("Apia: a date that does not exist has no slot, its neighbours are intact", async () => {
    const s = await setup("Pacific/Apia");
    const now = "2011-12-01T00:00:00Z";

    expect(await slots(s, "2011-12-30", now)).toEqual([]);
    const dec29 = await slots(s, "2011-12-29", now);
    const dec31 = await slots(s, "2011-12-31", now);
    expect(dec29).toHaveLength(48);
    expect(dec31).toHaveLength(48);
    // The 29th ends exactly where the 31st begins (the jump).
    expect(dec29.at(-1)!.endsAt).toBe(dec31[0]!.startsAt);
    expect(dec31[0]!.startsAt).toBe("2011-12-30T10:00:00.000Z");
  });

  it("Cairo: the repeated hour ends the day; 23:00 → 24:00 opens both occurrences", async () => {
    // 2026-10-29 (Thursday): 24:00 EEST → 23:00 EET at 21:00Z. 23:00–24:00
    // happens twice (20:00Z–21:00Z then 21:00Z–22:00Z); the day ends at 22:00Z.
    const s = await setup("Africa/Cairo", { hours: [[4, "23:00", "24:00"]] });

    expect(await openRanges(s, "2026-10-29")).toEqual([
      ["2026-10-29T20:00:00.000Z", "2026-10-29T22:00:00.000Z"],
    ]);
    expect(await slots(s, "2026-10-29")).toHaveLength(4);
    expect(await openRanges(s, "2026-10-22")).toEqual([
      ["2026-10-22T20:00:00.000Z", "2026-10-22T21:00:00.000Z"],
    ]);
  });

  it("Santiago and Beirut: the repeated hour is the end of the previous day", async () => {
    const santiago = await setup("America/Santiago");
    // 2027-04-03 lasts 25 h (23:00 repeated), 2026-09-06 23 h (midnight skipped).
    expect(await slots(santiago, "2027-04-03")).toHaveLength(50);
    const skipped = await slots(santiago, "2026-09-06", "2026-08-01T00:00:00Z");
    expect(skipped).toHaveLength(46);
    expect(skipped[0]!.startsAt).toBe("2026-09-06T04:00:00.000Z");

    const beirut = await setup("Asia/Beirut");
    expect(await slots(beirut, "2026-10-24")).toHaveLength(50);
  });
});

describe("adversarial zones and bounds inside the day", () => {
  it("Azores: midnight repeats every autumn (2026-10-25)", async () => {
    // 00:59 (UTC+0) → 00:00 (UTC−1) at 01:00Z: midnight at 00:00Z and 01:00Z.
    const s = await setup("Atlantic/Azores");

    const day = await slots(s, "2026-10-25");
    expect(day).toHaveLength(50);
    expect(day[0]!.startsAt).toBe("2026-10-25T00:00:00.000Z");
    expect(day.at(-1)!.endsAt).toBe("2026-10-26T01:00:00.000Z");
    expect((await slots(s, "2026-10-24")).at(-1)!.endsAt).toBe(
      "2026-10-25T00:00:00.000Z",
    );
  });

  it("repeated hour inside the day: real duration, no duplicate", async () => {
    // Paris 2026-10-25, 01:00 → 03:00 spans 01:00 CEST → 03:00 CET: 3 real
    // hours, and 02:00/02:30 appear twice as distinct instants.
    const s = await setup("Europe/Paris", { hours: [[0, "01:00", "03:00"]] });

    expect(starts(await slots(s, "2026-10-25"))).toEqual([
      "2026-10-24T23:00:00.000Z",
      "2026-10-24T23:30:00.000Z",
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
  });

  it("a range starting in the repeated hour opens both occurrences of its part", async () => {
    // Paris 2026-10-25, 03:00 CEST → 02:00 CET at 01:00Z. 02:30 → 04:00 is
    // every instant whose wall clock is in [02:30, 04:00): the first
    // 02:30–03:00 (00:30Z–01:00Z) and the second 02:30–04:00 (01:30Z–03:00Z).
    const s = await setup("Europe/Paris", { hours: [[0, "02:30", "04:00"]] });

    expect(await openRanges(s, "2026-10-25")).toEqual([
      ["2026-10-25T00:30:00.000Z", "2026-10-25T01:00:00.000Z"],
      ["2026-10-25T01:30:00.000Z", "2026-10-25T03:00:00.000Z"],
    ]);
    expect(starts(await slots(s, "2026-10-25"))).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T02:30:00.000Z",
    ]);
    // Never the first 02:00–02:30, which is outside [02:30, 04:00).
    expect(starts(await slots(s, "2026-10-25"))).not.toContain(
      "2026-10-25T00:00:00.000Z",
    );
  });

  it("a range bound in the spring gap: what exists of it, never a negative interval", async () => {
    // Paris 2027-03-28: 02:00–03:00 does not exist (01:00Z: 02:00 → 03:00).
    const opening = await setup("Europe/Paris", {
      hours: [[0, "02:30", "04:00"]],
    });
    // [02:30, 04:00) exists only as 03:00–04:00 CEST = 01:00Z–02:00Z.
    expect(await openRanges(opening, "2027-03-28")).toEqual([
      ["2027-03-28T01:00:00.000Z", "2027-03-28T02:00:00.000Z"],
    ]);
    expect(starts(await slots(opening, "2027-03-28"))).toEqual([
      "2027-03-28T01:00:00.000Z",
      "2027-03-28T01:30:00.000Z",
    ]);

    // Closing in the gap: [01:00, 02:30) exists only as 01:00–02:00 CET,
    // never past 03:00 CEST.
    const closing = await setup("Europe/Paris", {
      hours: [[0, "01:00", "02:30"]],
    });
    expect(await openRanges(closing, "2027-03-28")).toEqual([
      ["2027-03-28T00:00:00.000Z", "2027-03-28T01:00:00.000Z"],
    ]);

    // Entirely inside the gap: nothing, for that day only.
    const inside = await setup("Europe/Paris", {
      hours: [[0, "02:30", "03:00"]],
    });
    expect(await openRanges(inside, "2027-03-28")).toEqual([]);
    expect(await slots(inside, "2027-03-28")).toEqual([]);
    expect(await openRanges(inside, "2027-04-04")).toEqual([
      ["2027-04-04T00:30:00.000Z", "2027-04-04T01:00:00.000Z"],
    ]);
  });

  it("a long service never crosses into the next civil day", async () => {
    const s = await setup(HAVANA, { durationMinutes: 90 });

    const oct31 = await slots(s, "2026-10-31");
    expect(oct31.at(-1)).toEqual({
      startsAt: "2026-11-01T02:30:00.000Z",
      endsAt: "2026-11-01T04:00:00.000Z",
    });
  });
});

describe("PostgreSQL is the only calendar authority", () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;

  afterEach(() => {
    Intl.DateTimeFormat = RealDateTimeFormat;
  });

  it("Vancouver 2027-03-14, 00:00 → 01:00: agenda, availability and booking use the same instants", async () => {
    // Node and PostgreSQL ship different tzdata: Node 24 (2026c) reads
    // Vancouver as UTC−7 all year from November 2026, this database
    // (2025b) as UTC−8 until 14 March 2027 02:00. Nothing is excluded here:
    // whatever Node believes, every result follows the database.
    const VANCOUVER = "America/Vancouver";
    const DAY = "2027-03-14"; // Sunday
    const s = await setup(VANCOUVER, { hours: [[0, "00:00", "01:00"]] });
    const { rows } = await db.query<{ start: Date }>(
      "select private.local_day_start($1::date, $2) as start",
      [DAY, VANCOUVER],
    );
    const start = rows[0]!.start.getTime();
    // 08:00Z with this database's rules (UTC−8); 07:00Z once it has 2026 rules.
    expect(["2027-03-14T07:00:00.000Z", "2027-03-14T08:00:00.000Z"]).toContain(
      iso(start),
    );
    const at = (minutes: number) => iso(start + minutes * 60_000);
    const context = { businessId: s.businessId, timezone: VANCOUVER };

    // Agenda: the opening range of the day, from the database.
    const before = await getAgenda(s.ownerClient, context, {
      startDate: DAY,
      endDate: DAY,
      includeCancelled: false,
    });
    expect(before.workingHours.days[0]).toMatchObject({
      date: DAY,
      startsAt: at(0),
      openRanges: [
        {
          startsAt: at(0),
          endsAt: at(60),
          localStartsAt: `${DAY}T00:00`,
          localEndsAt: `${DAY}T01:00`,
        },
      ],
    });

    // Public availability: the same two slots, with the same wall clocks.
    const listed = await slots(s, DAY);
    expect(starts(listed)).toEqual([at(0), at(30)]);
    expect(await pgWalls(starts(listed), VANCOUVER)).toEqual([
      `${DAY}T00:00`,
      `${DAY}T00:30`,
    ]);

    // A professional types 00:00 in the agenda: the database resolves it.
    const manual = await createManualAppointment(s.ownerClient, context, {
      date: DAY,
      time: "00:00",
      occurrence: undefined,
      serviceId: s.serviceId,
      client: {
        type: "new",
        firstName: "Agenda",
        lastName: null,
        email: null,
        phone: null,
      },
      internalNotes: null,
    });
    expect(manual.appointment).toMatchObject({
      startsAt: at(0),
      localStartsAt: `${DAY}T00:00`,
      startOccurrence: null,
    });

    // Public booking: 00:30 is bookable; an hour earlier is not open.
    expect(starts(await slots(s, DAY))).toEqual([at(30)]);
    await expect(book(s, at(30))).resolves.toBe(at(30));
    await expect(book(s, at(-60))).rejects.toMatchObject({
      message: "slot_unavailable",
    });

    // The agenda and its grid show the booking at 00:30, from the database's
    // offsets, whatever the JS runtime's tzdata says about that instant.
    const after = await getAgenda(s.ownerClient, context, {
      startDate: DAY,
      endDate: DAY,
      includeCancelled: false,
    });
    expect(
      after.appointments.map((item) => [item.startsAt, item.localStartsAt]),
    ).toEqual([
      [at(0), `${DAY}T00:00`],
      [at(30), `${DAY}T00:30`],
    ]);
    const zone = zoneOf(after);
    expect(wallOf(zone, start + 30 * 60_000)).toBe(`${DAY}T00:30`);
    const axis = buildAxis([DAY], zone);
    expect(
      placeAppointments(axis, after.appointments, DAY).map((item) => item.top),
    ).toEqual([0, 30]);

    // Recorded, never used: Node's own reading of that instant.
    expect([`${DAY}T00:30`, `${DAY}T01:30`]).toContain(
      utcToZonedLocal(at(30), VANCOUVER),
    );
  });

  it("a JS time zone database that disagrees changes nothing (synthetic divergence)", async () => {
    const s = await setup(HAVANA, { hours: [[0, "00:00", "00:30"]] });
    const context = { businessId: s.businessId, timezone: HAVANA };

    // From now on, the JS runtime reads every zone as Asia/Kathmandu
    // (UTC+5:45): any schedule time still derived from Intl would move.
    Intl.DateTimeFormat = function (
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new RealDateTimeFormat(
        locales,
        options?.timeZone && options.timeZone !== "UTC"
          ? { ...options, timeZone: "Asia/Kathmandu" }
          : options,
      );
    } as unknown as typeof Intl.DateTimeFormat;
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: HAVANA,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date("2026-11-01T04:30:00Z")),
    ).toBe("10:15"); // JS now says 10:15; Havana really reads 00:30.

    const agenda = await getAgenda(s.ownerClient, context, {
      startDate: "2026-10-31",
      endDate: REPEATED,
      includeCancelled: false,
    });
    expect(
      agenda.workingHours.days.map((day) => [
        day.date,
        day.startsAt,
        day.endsAt,
      ]),
    ).toEqual([
      ["2026-10-31", "2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"],
      [REPEATED, "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ]);
    expect(
      agenda.workingHours.days[1]!.openRanges.map((range) => [
        range.startsAt,
        range.endsAt,
        range.localStartsAt,
        range.localEndsAt,
      ]),
    ).toEqual([
      [
        "2026-11-01T04:00:00.000Z",
        "2026-11-01T04:30:00.000Z",
        "2026-11-01T00:00",
        "2026-11-01T00:30",
      ],
      [
        "2026-11-01T05:00:00.000Z",
        "2026-11-01T05:30:00.000Z",
        "2026-11-01T00:00",
        "2026-11-01T00:30",
      ],
    ]);
    expect(agenda.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Writes: a start typed with its occurrence, a period, whole days.
    const created = await createManualAppointment(s.ownerClient, context, {
      date: REPEATED,
      time: "00:00",
      occurrence: "second",
      serviceId: s.serviceId,
      client: {
        type: "new",
        firstName: "Divergence",
        lastName: null,
        email: null,
        phone: null,
      },
      internalNotes: null,
    });
    expect(created.appointment).toMatchObject({
      startsAt: "2026-11-01T05:00:00.000Z",
      localStartsAt: "2026-11-01T00:00",
      startOccurrence: "second",
    });
    const period = await createBlock(s.ownerClient, context, {
      allDay: false,
      startsAt: "2026-11-02T09:00",
      endsAt: "2026-11-02T10:00",
      reason: null,
    });
    expect([period.startsAt, period.endsAt]).toEqual([
      "2026-11-02T14:00:00.000Z",
      "2026-11-02T15:00:00.000Z",
    ]);
    const wholeDay = await createBlock(s.ownerClient, context, {
      allDay: true,
      startDate: "2026-11-08",
      endDate: "2026-11-08",
      reason: null,
    });
    expect([wholeDay.startsAt, wholeDay.endsAt]).toEqual([
      "2026-11-08T05:00:00.000Z",
      "2026-11-09T05:00:00.000Z",
    ]);

    // Public side: unchanged, and the slot taken by the agenda is gone.
    expect(starts(await slots(s, REPEATED))).toEqual([
      "2026-11-01T04:00:00.000Z",
    ]);

    // UI: the grid places items with the database's offsets only.
    const after = await getAgenda(s.ownerClient, context, {
      startDate: REPEATED,
      endDate: REPEATED,
      includeCancelled: false,
    });
    const zone = zoneOf(after);
    expect(wallOf(zone, Date.parse("2026-11-01T05:00:00Z"))).toBe(
      "2026-11-01T00:00",
    );
    const axis = buildAxis([REPEATED], zone);
    // Repeated midnight: y is the real time since the first midnight.
    expect(
      placeAppointments(axis, after.appointments, REPEATED).map(
        (item) => item.top,
      ),
    ).toEqual([60]);
  });

  it("public.business_time answers members only, with bounded inputs", async () => {
    const s = await setup(HAVANA);
    const outsider = await createProfessional("outsider");
    const call = (client: Setup["ownerClient"], args: object = {}) =>
      client.rpc("business_time", { p_business_id: s.businessId, ...args });

    const member = await call(s.ownerClient, {
      p_dates: [REPEATED],
      p_locals: ["2026-11-01T00:30"],
      p_instants: ["2026-11-01T04:30:00Z", "2026-11-01T05:30:00Z"],
    });
    expect(member.error).toBeNull();
    expect(member.data).toMatchObject({
      timezone: HAVANA,
      days: [
        {
          date: REPEATED,
          startsAt: expect.stringMatching(/^2026-11-01T04:00:00/),
          endsAt: expect.stringMatching(/^2026-11-02T05:00:00/),
        },
      ],
      locals: [{ local: "2026-11-01T00:30", status: "ambiguous" }],
      instants: expect.arrayContaining([
        expect.objectContaining({
          local: "2026-11-01T00:30",
          occurrence: "first",
        }),
        expect.objectContaining({
          local: "2026-11-01T00:30",
          occurrence: "second",
        }),
      ]),
    });

    expect((await call(outsider.client)).error).toMatchObject({
      message: "forbidden",
    });
    expect((await call(anonClient())).error).not.toBeNull();
    const tooMany = Array.from({ length: 63 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    );
    expect(
      (await call(s.ownerClient, { p_dates: tooMany })).error,
    ).toMatchObject({ message: "invalid_input" });
  });

  it("holds the civil-day invariants for every IANA zone, 2018–2028 (nothing excluded)", async () => {
    // Product guarantee: the database alone defines days. Every zone, every
    // day whose midnight is irregular or near a change.
    const { rows } = await db.query<{
      name: string;
      ymd: string;
      ge: boolean;
      first: boolean;
      ordered: boolean;
      membership: boolean;
    }>(
      `with z as (select name from pg_timezone_names where name !~ '^(posix|right)/'),
            d as (select g::date as dd from generate_series('2018-01-01'::date, '2028-12-31'::date, interval '1 day') g),
            c as (select z.name, d.dd, (d.dd::timestamp at time zone z.name) as rule from z cross join d),
            s as (select name, dd,
                         private.local_day_start(dd, name) as st,
                         private.local_day_start(dd + 1, name) as nx
                  from c
                  where (rule at time zone name) <> dd::timestamp
                     or ((rule - interval '3 hours') at time zone name) - ((rule - interval '3 hours') at time zone 'UTC')
                        <> ((rule + interval '3 hours') at time zone name) - ((rule + interval '3 hours') at time zone 'UTC'))
       select name, to_char(dd, 'YYYY-MM-DD') as ymd,
              (st at time zone name)::date >= dd as ge,
              ((st - interval '1 minute') at time zone name)::date < dd as first,
              nx >= st as ordered,
              (st = nx or private.local_date_of(st, name) = dd) as membership
       from s`,
    );

    expect(rows.length).toBeGreaterThan(1000);
    const broken = rows.filter(
      (row) => !(row.ge && row.first && row.ordered && row.membership),
    );
    expect(broken).toEqual([]);
  }, 180_000);

  it("00:00 → 24:00 opens exactly the real day, in every IANA zone (2018–2028)", async () => {
    const s = await setup("UTC"); // every weekday 00:00 → 24:00
    const { rows } = await db.query<{ name: string; ymd: string }>(
      `with z as (select name from pg_timezone_names where name !~ '^(posix|right)/'),
            d as (select g::date as dd from generate_series('2018-01-01'::date, '2028-12-31'::date, interval '1 day') g),
            c as (select z.name, d.dd, (d.dd::timestamp at time zone z.name) as rule from z cross join d),
            s as (select name, dd from c
                  where (rule at time zone name) <> dd::timestamp
                     or ((rule - interval '3 hours') at time zone name) - ((rule - interval '3 hours') at time zone 'UTC')
                        <> ((rule + interval '3 hours') at time zone name) - ((rule + interval '3 hours') at time zone 'UTC'))
       select name, to_char(dd, 'YYYY-MM-DD') as ymd
       from s
       where coalesce(private.opening_ranges($1, dd, name), '{}'::tstzmultirange)
          <> case
               when private.local_day_start(dd, name) < private.local_day_start(dd + 1, name)
               then tstzmultirange(tstzrange(private.local_day_start(dd, name),
                                             private.local_day_start(dd + 1, name), '[)'))
               else '{}'::tstzmultirange
             end`,
      [s.businessId],
    );
    expect(rows).toEqual([]);
  }, 300_000);

  it("the UI's arithmetic on the database's offsets reproduces the database's wall clocks", async () => {
    // Same data, same result: around every change of every zone (2024–2027),
    // the agenda zone (offsets from private.zone_offsets) gives exactly
    // private.wall_clock at each piece's first and last minute.
    const { rows } = await db.query<{
      name: string;
      pieces: { startsAt: string; endsAt: string; offsetSeconds: number }[];
      probes: { at: string; wall: string }[];
    }>(
      `with z as (select name from pg_timezone_names where name !~ '^(posix|right)/'),
            d as (select g::date as dd from generate_series('2024-01-01'::date, '2027-12-31'::date, interval '1 day') g),
            c as (select z.name, d.dd, private.local_day_start(d.dd, z.name) as lo,
                         private.local_day_start(d.dd + 1, z.name) as hi
                  from z cross join d),
            t as (select name, lo, hi from c
                  where hi - lo <> interval '24 hours')
       select t.name,
              (select json_agg(json_build_object('startsAt', p.starts_at, 'endsAt', p.ends_at,
                                                 'offsetSeconds', p.utc_offset_seconds)
                               order by p.starts_at)
               from private.zone_offsets(t.name, t.lo, t.hi) p) as pieces,
              (select json_agg(json_build_object('at', x, 'wall', private.wall_clock(x, t.name)))
               from private.zone_offsets(t.name, t.lo, t.hi) p,
                    unnest(array[p.starts_at, p.ends_at - interval '1 minute']) x) as probes
       from t
       where t.lo < t.hi`,
    );

    expect(rows.length).toBeGreaterThan(500);
    const mismatches: string[] = [];
    for (const row of rows) {
      const zone = zoneOf({
        timezone: row.name,
        offsets: row.pieces,
        workingHours: { days: [] },
      });
      for (const probe of row.probes) {
        const wall = wallOf(zone, Date.parse(probe.at));
        if (wall !== probe.wall) mismatches.push(`${row.name} ${probe.at}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 180_000);

  it("algorithm cross-check with Intl where both tzdata agree (tzdata differences only recorded)", async () => {
    // Not a product guarantee (the product never reads Intl): an independent
    // implementation of the civil-day definition, compared wherever Node and
    // the database read the same wall clocks. Days on which their tzdata
    // differ (America/Vancouver 2027 with Node ≥ 24) are recorded, not
    // compared — the tests above prove they cannot change any result.
    const { rows } = await db.query<{
      name: string;
      ymd: string;
      start: Date;
      probes: { at: string; wall: string }[];
    }>(
      `with z as (select name from pg_timezone_names where name !~ '^(posix|right)/'),
            d as (select g::date as dd from generate_series('2024-01-01'::date, '2027-12-31'::date, interval '1 day') g),
            c as (select z.name, d.dd, (d.dd::timestamp at time zone z.name) as rule from z cross join d),
            s as (select name, dd, private.local_day_start(dd, name) as st
                  from c
                  where (rule at time zone name) <> dd::timestamp
                     or ((rule - interval '3 hours') at time zone name) - ((rule - interval '3 hours') at time zone 'UTC')
                        <> ((rule + interval '3 hours') at time zone name) - ((rule + interval '3 hours') at time zone 'UTC'))
       select name, to_char(dd, 'YYYY-MM-DD') as ymd, st as start,
              (select json_agg(json_build_object(
                        'at', p,
                        'wall', to_char(p at time zone name, 'YYYY-MM-DD"T"HH24:MI')))
               from unnest(array[st - interval '26 hours', st - interval '1 minute', st,
                                 st + interval '26 hours']) p) as probes
       from s`,
    );

    const tzdataDifferences: string[] = [];
    let compared = 0;
    for (const row of rows) {
      const sameRules = row.probes.every(
        (probe) => utcToZonedLocal(probe.at, row.name) === probe.wall,
      );
      if (!sameRules) {
        tzdataDifferences.push(`${row.name} ${row.ymd}`);
        continue;
      }
      compared += 1;
      expect([row.name, row.ymd, row.start.toISOString()]).toEqual([
        row.name,
        row.ymd,
        startOfLocalDate(row.ymd, row.name).toISOString(),
      ]);
    }
    expect(compared).toBeGreaterThan(100);
    if (tzdataDifferences.length > 0) {
      console.info(
        `tzdata differs between Node and PostgreSQL on ${tzdataDifferences.length} day(s), e.g. ${tzdataDifferences.slice(0, 5).join(", ")}`,
      );
    }
  }, 120_000);
});
