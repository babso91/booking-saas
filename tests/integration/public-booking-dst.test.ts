import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { getAgenda } from "@/features/agenda/data/agenda";
import { createBlock } from "@/features/agenda/data/blocks";
import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { getAvailableSlots } from "@/features/availability/data/slots";
import {
  addDaysToLocalDate,
  resolveZonedLocal,
  startOfLocalDate,
  zonedDateOf,
  utcToZonedLocal,
} from "@/lib/time/zoned";

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

// Public availability and booking use the same civil day as the agenda:
// day D = [first real instant of D, first real instant of D + 1).
// Critical expectations are explicit UTC instants.

const HOUR = 3_600_000;
const HAVANA = "America/Havana";
// 2026-11-01: 00:59 CDT → 00:00 CST at 05:00Z. Midnight at 04:00Z and 05:00Z.
const REPEATED = "2026-11-01";
const ALL_DAY: [string, string] = ["00:00", "24:00"];

type Setup = {
  businessId: string;
  slug: string;
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
    serviceId,
    ownerClient: owner.client,
  };
}

/** private.available_slots with an explicit "now", as UTC ISO strings. */
async function slots(s: Setup, date: string, now = "2026-09-01T00:00:00Z") {
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
      for (const slot of await slots(s, date)) {
        // Each slot belongs to the day of its real instant.
        expect(zonedDateOf(slot.startsAt, HAVANA)).toBe(date);
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

describe("public booking agrees with the listing (real RPC, real now)", () => {
  /** Next date whose local midnight is repeated in Havana (from tzdata). */
  function nextRepeatedMidnight() {
    let date = addDaysToLocalDate(new Date().toISOString().slice(0, 10), 2);
    for (let i = 0; i < 366; i += 1, date = addDaysToLocalDate(date, 1)) {
      const midnight = resolveZonedLocal(`${date}T00:00`, HAVANA);
      if (midnight.status === "ambiguous") return { date, ...midnight };
    }
    throw new Error("No repeated midnight in Havana within a year");
  }

  it("books both 00:30 occurrences of the repeated midnight", async () => {
    const { date, first, second } = nextRepeatedMidnight();
    expect(second.getTime() - first.getTime()).toBe(HOUR);
    const s = await setup(HAVANA);

    const listed = starts(
      await getAvailableSlots(anonClient(), {
        slug: s.slug,
        serviceId: s.serviceId,
        date,
      }),
    );
    const firstHalf = iso(first.getTime() + HOUR / 2);
    const secondHalf = iso(second.getTime() + HOUR / 2);
    expect(listed[0]).toBe(first.toISOString());
    expect(listed).toContain(firstHalf);
    expect(listed).toContain(secondHalf);

    // What is listed is what can be booked, at the very first instant too.
    for (const startsAt of [first.toISOString(), firstHalf, secondHalf]) {
      await expect(
        createPublicBooking(anonClient(), {
          slug: s.slug,
          serviceId: s.serviceId,
          startsAt,
          firstName: "Cliente",
          email: `${randomUUID()}@x.test`,
        }),
      ).resolves.toMatchObject({ startsAt });
    }

    // The previous day lists nothing from the first real hour.
    const before = starts(
      await getAvailableSlots(anonClient(), {
        slug: s.slug,
        serviceId: s.serviceId,
        date: addDaysToLocalDate(date, -1),
      }),
    );
    expect(before.every((value) => value < first.toISOString())).toBe(true);
  });

  it("under a whole-day closure: nothing listed and nothing bookable", async () => {
    const { date, first, second } = nextRepeatedMidnight();
    const s = await setup(HAVANA);
    await createBlock(
      s.ownerClient,
      { businessId: s.businessId, timezone: HAVANA },
      { allDay: true, startDate: date, endDate: date, reason: null },
    );

    expect(
      await getAvailableSlots(anonClient(), {
        slug: s.slug,
        serviceId: s.serviceId,
        date,
      }),
    ).toEqual([]);

    for (const startsAt of [
      first.toISOString(),
      iso(first.getTime() + HOUR / 2),
      iso(second.getTime() + HOUR / 2),
    ]) {
      await expect(
        createPublicBooking(anonClient(), {
          slug: s.slug,
          serviceId: s.serviceId,
          startsAt,
          firstName: "Cliente",
          email: `${randomUUID()}@x.test`,
        }),
      ).rejects.toMatchObject({ code: "slot_unavailable" });
    }

    const { rows } = await db.query(
      "select count(*)::int as count from public.appointments where business_id = $1",
      [s.businessId],
    );
    expect(rows[0].count).toBe(0);
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

  it("a bound in the repeated hour is its later occurrence (documented rule)", async () => {
    // 02:30 → 04:00 starts at the second 02:30 (01:30Z), as before this change.
    const s = await setup("Europe/Paris", { hours: [[0, "02:30", "04:00"]] });

    expect(starts(await slots(s, "2026-10-25"))).toEqual([
      "2026-10-25T01:30:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T02:30:00.000Z",
    ]);
  });

  it("a bound in the spring gap keeps PostgreSQL's rule, no invented slot", async () => {
    // Paris 2027-03-28: 02:30 does not exist; read with the offset before
    // the change it is 01:30Z (03:30 CEST). 04:00 CEST = 02:00Z.
    const s = await setup("Europe/Paris", { hours: [[0, "02:30", "04:00"]] });

    expect(await slots(s, "2027-03-28")).toEqual([
      {
        startsAt: "2027-03-28T01:30:00.000Z",
        endsAt: "2027-03-28T02:00:00.000Z",
      },
    ]);
    // 02:30 → 03:00 converts to 01:30Z → 01:00Z (inverted): dropped for that
    // day only, as documented since 20260928090000.
    const gap = await setup("Europe/Paris", {
      hours: [[0, "02:30", "03:00"]],
    });
    expect(await slots(gap, "2027-03-28")).toEqual([]);
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

describe("SQL and TypeScript share one definition of a civil day", () => {
  it("holds the civil-day invariants for every IANA zone, 2024–2027", async () => {
    // Only days whose midnight is irregular (repeated or skipped) are
    // interesting; on the others both rules trivially agree.
    const { rows } = await db.query<{
      name: string;
      ymd: string;
      start: Date;
      next: Date;
      ge: boolean;
      first: boolean;
      probes: { at: string; wall: string }[];
    }>(
      `with z as (select name from pg_timezone_names where name !~ '^(posix|right)/'),
            d as (select g::date as dd from generate_series('2024-01-01'::date, '2027-12-31'::date, interval '1 day') g),
            c as (select z.name, d.dd, (d.dd::timestamp at time zone z.name) as rule from z cross join d),
            s as (select name, dd,
                         private.local_day_start(dd, name) as st,
                         private.local_day_start(dd + 1, name) as nx
                  from c
                  where (rule at time zone name) <> dd::timestamp
                     or ((rule - interval '3 hours') at time zone name) - ((rule - interval '3 hours') at time zone 'UTC')
                        <> ((rule + interval '3 hours') at time zone name) - ((rule + interval '3 hours') at time zone 'UTC'))
       select name, to_char(dd, 'YYYY-MM-DD') as ymd, st as start, nx as next,
              (st at time zone name)::date >= dd as ge,
              ((st - interval '1 minute') at time zone name)::date < dd as first,
              (select json_agg(json_build_object(
                        'at', p,
                        'wall', to_char(p at time zone name, 'YYYY-MM-DD"T"HH24:MI')))
               from unnest(array[st - interval '26 hours', st - interval '1 minute', st,
                                 st + interval '26 hours']) p) as probes
       from s`,
    );

    expect(rows.length).toBeGreaterThan(100);

    // PostgreSQL and Node each ship their own copy of the IANA database, and
    // the two can disagree on future rules (on the CI runner, Node reads
    // America/Vancouver on 2027-03-14 at UTC−7 where PostgreSQL still has
    // UTC−8). The comparison with startOfLocalDate is only meaningful where
    // both runtimes read the same wall clocks around the day; elsewhere the
    // gap is a tzdata difference, never a difference of definition.
    const compared: string[] = [];
    const tzdataGaps: string[] = [];
    for (const row of rows) {
      expect([
        row.name,
        row.ymd,
        row.ge,
        row.first,
        row.next >= row.start,
      ]).toEqual([row.name, row.ymd, true, true, true]);

      const sameRules = row.probes.every(
        (probe) => utcToZonedLocal(probe.at, row.name) === probe.wall,
      );
      if (!sameRules) {
        tzdataGaps.push(`${row.name} ${row.ymd}`);
        continue;
      }

      compared.push(`${row.name} ${row.ymd}`);
      expect([row.name, row.ymd, row.start.toISOString()]).toEqual([
        row.name,
        row.ymd,
        startOfLocalDate(row.ymd, row.name).toISOString(),
      ]);
    }

    // The escape hatch above must stay marginal: almost every irregular day
    // is really compared.
    expect(compared.length).toBeGreaterThan(100);
    expect(tzdataGaps.length).toBeLessThan(rows.length / 20);
  }, 120_000);

  it("agenda opening ranges cover exactly the public slots of each day", async () => {
    const s = await setup(HAVANA);
    const agenda = await getAgenda(
      s.ownerClient,
      { businessId: s.businessId, timezone: HAVANA },
      {
        startDate: "2026-10-31",
        endDate: "2026-11-02",
        includeCancelled: false,
      },
    );

    for (const day of agenda.workingHours.days) {
      const daySlots = await slots(s, day.date);
      expect(day.openRanges).toHaveLength(1);
      expect([day.openRanges[0]!.startsAt, day.openRanges[0]!.endsAt]).toEqual([
        daySlots[0]!.startsAt,
        daySlots.at(-1)!.endsAt,
      ]);
    }
    expect(agenda.workingHours.days[1]!.openRanges[0]).toMatchObject({
      startsAt: "2026-11-01T04:00:00.000Z",
      endsAt: "2026-11-02T05:00:00.000Z",
    });
  });

  it("private.local_day_start equals startOfLocalDate across atypical zones", async () => {
    const zones: [string, string, string][] = [
      ["America/Havana", "2025-01-01", "2027-12-31"],
      ["America/Santiago", "2026-01-01", "2027-12-31"],
      ["Asia/Beirut", "2026-01-01", "2027-12-31"],
      ["Africa/Cairo", "2026-01-01", "2027-12-31"],
      ["America/Nuuk", "2025-01-01", "2027-12-31"],
      ["Australia/Lord_Howe", "2026-01-01", "2027-12-31"],
      ["Pacific/Chatham", "2026-01-01", "2026-12-31"],
      ["Antarctica/Troll", "2026-01-01", "2027-12-31"],
      ["Pacific/Apia", "2011-12-01", "2012-01-31"],
      ["America/Sao_Paulo", "2018-01-01", "2019-12-31"],
      ["Atlantic/Azores", "2025-01-01", "2027-12-31"],
      ["Asia/Gaza", "2025-01-01", "2027-12-31"],
      ["Asia/Amman", "2020-01-01", "2022-12-31"],
      ["America/Scoresbysund", "2024-01-01", "2026-12-31"],
      ["Europe/Paris", "2026-01-01", "2027-12-31"],
    ];

    for (const [zone, from, to] of zones) {
      const { rows } = await db.query<{ day: string; start: Date }>(
        `select to_char(d, 'YYYY-MM-DD') as day, private.local_day_start(d::date, $1) as start
         from generate_series($2::date, $3::date, interval '1 day') as d`,
        [zone, from, to],
      );
      for (const row of rows) {
        expect([zone, row.day, row.start.toISOString()]).toEqual([
          zone,
          row.day,
          startOfLocalDate(row.day, zone).toISOString(),
        ]);
      }
    }
  });
});
