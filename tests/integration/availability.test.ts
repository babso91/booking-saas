import { beforeEach, describe, expect, it } from "vitest";

import {
  addException,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  everyDay,
  insertAppointment,
  setWeeklyHours,
  updateSettings,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Deterministic tests of private.available_slots with an explicit "now".
// Results are compared as local wall-clock times of the business zone.

const DAY = "2030-06-12"; // a Wednesday
const NOW = "2030-06-01T00:00:00Z";

let owner: Professional;
let business: TestBusiness;
let service: string;

async function slots(
  options: {
    businessId?: string;
    serviceId?: string;
    date?: string;
    now?: string;
    timezone?: string;
  } = {},
) {
  const { rows } = await db.query<{ local: string }>(
    `select to_char(starts_at at time zone $5, 'HH24:MI') as local
     from private.available_slots($1, $2, $3::date, $4::timestamptz)`,
    [
      options.businessId ?? business.id,
      options.serviceId ?? service,
      options.date ?? DAY,
      options.now ?? NOW,
      options.timezone ?? business.timezone,
    ],
  );

  return rows.map((row) => row.local);
}

/** Local wall-clock time of the business on DAY → timestamptz literal. */
async function at(localTime: string, date = DAY, timezone = business.timezone) {
  const { rows } = await db.query<{ instant: Date }>(
    "select ($1::date + $2::time) at time zone $3 as instant",
    [date, localTime, timezone],
  );

  return rows[0]!.instant.toISOString();
}

beforeEach(async () => {
  owner ??= await createProfessional("availability");
  business = await createBusiness(owner.userId, {
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
    },
  });
  service = await createService(business.id, { durationMinutes: 60 });
  await setWeeklyHours(
    business.id,
    everyDay(["10:00", "13:00"], ["14:00", "19:00"]),
  );
});

describe("weekly hours", () => {
  it("offers every grid step of several ranges in one day", async () => {
    expect(await slots()).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "11:30",
      "12:00",
      "14:00",
      "14:30",
      "15:00",
      "15:30",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
      "18:00",
    ]);
  });

  it("offers nothing on a day without any range (closed weekday)", async () => {
    // Wednesday = 3: keep every day but Wednesday open.
    await setWeeklyHours(
      business.id,
      everyDay(["10:00", "13:00"]).filter(([weekday]) => weekday !== 3),
    );

    expect(await slots()).toEqual([]);
    expect(await slots({ date: "2030-06-13" })).not.toEqual([]);
  });

  it("uses the weekday of the local date (0 = Sunday)", async () => {
    await setWeeklyHours(business.id, [[3, "09:00", "10:00"]]);

    expect(await slots({ date: "2030-06-12" })).toEqual(["09:00"]);
    expect(await slots({ date: "2030-06-11" })).toEqual([]);
  });

  it("supports a range ending at midnight (24:00)", async () => {
    await setWeeklyHours(business.id, everyDay(["22:00", "24:00"]));

    expect(await slots()).toEqual(["22:00", "22:30", "23:00"]);
  });
});

describe("service duration and grid", () => {
  it("only offers starts whose full duration fits in a range", async () => {
    const long = await createService(business.id, { durationMinutes: 90 });

    expect(await slots({ serviceId: long })).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "11:30",
      "14:00",
      "14:30",
      "15:00",
      "15:30",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
    ]);
  });

  it("anchors the grid on the opening time", async () => {
    await updateSettings(business.id, { slot_interval_minutes: 45 });
    await setWeeklyHours(business.id, everyDay(["09:10", "12:00"]));

    expect(await slots()).toEqual(["09:10", "09:55", "10:40"]);
  });

  it("never offers an inactive service", async () => {
    await db.query("update public.services set active = false where id = $1", [
      service,
    ]);

    expect(await slots()).toEqual([]);
  });

  it("never offers a service through another business", async () => {
    const other = await createBusiness(owner.userId);
    await setWeeklyHours(other.id, everyDay(["10:00", "13:00"]));

    expect(await slots({ businessId: other.id })).toEqual([]);
  });
});

describe("exceptions", () => {
  it("removes slots intersecting a blocked period", async () => {
    await addException(
      business.id,
      "blocked",
      await at("11:15"),
      await at("12:00"),
    );

    expect(await slots()).toEqual([
      "10:00",
      "12:00",
      "14:00",
      "14:30",
      "15:00",
      "15:30",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
      "18:00",
    ]);
  });

  it("closes whole days during holidays spanning several days", async () => {
    await addException(
      business.id,
      "closed",
      await at("00:00", "2030-06-10"),
      await at("00:00", "2030-06-15"),
    );

    expect(await slots({ date: "2030-06-12" })).toEqual([]);
    expect(await slots({ date: "2030-06-14" })).toEqual([]);
    expect(await slots({ date: "2030-06-15" })).not.toEqual([]);
  });

  it("opens exceptionally on a closed day", async () => {
    await setWeeklyHours(business.id, []);
    await addException(
      business.id,
      "open_override",
      await at("09:00"),
      await at("11:00"),
    );

    expect(await slots()).toEqual(["09:00", "09:30", "10:00"]);
  });

  it("gives priority to a closure over an exceptional opening", async () => {
    await addException(
      business.id,
      "open_override",
      await at("08:00"),
      await at("10:00"),
    );
    await addException(
      business.id,
      "closed",
      await at("00:00"),
      await at("00:00", "2030-06-13"),
    );

    expect(await slots()).toEqual([]);
  });

  it("ignores exceptions of another business", async () => {
    const other = await createBusiness(owner.userId);
    await addException(
      other.id,
      "closed",
      await at("00:00"),
      await at("23:59"),
    );

    expect(await slots()).toHaveLength(14);
  });
});

describe("existing appointments and buffer", () => {
  let client: string;

  beforeEach(async () => {
    client = await createClientRecord(business.id, "slot@example.test");
  });

  it("removes slots overlapping a confirmed appointment", async () => {
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: await at("11:00"),
      endsAt: await at("12:00"),
    });

    expect(await slots()).toEqual([
      "10:00",
      "12:00",
      "14:00",
      "14:30",
      "15:00",
      "15:30",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
      "18:00",
    ]);
  });

  it("keeps the configured buffer after existing and new appointments", async () => {
    await updateSettings(business.id, {
      buffer_minutes: 15,
      slot_interval_minutes: 15,
    });
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: await at("11:00"),
      endsAt: await at("12:00"),
      bufferMinutes: 15,
    });

    const morning = (await slots()).filter((time) => time < "13:00");

    // Before: 60 min + 15 min buffer must end by 11:00 → last start 09:45 is
    // before opening, so 10:00 is refused too. After: 12:00 + 15 min buffer.
    expect(morning).toEqual([]);

    await setWeeklyHours(business.id, everyDay(["08:00", "13:15"]));
    expect((await slots()).filter((time) => time < "13:00")).toEqual([
      "08:00",
      "08:15",
      "08:30",
      "08:45",
      "09:00",
      "09:15",
      "09:30",
      "09:45",
      "12:15",
    ]);
  });

  it("lets an appointment end exactly at closing time despite the buffer", async () => {
    await updateSettings(business.id, { buffer_minutes: 30 });

    expect(await slots()).toContain("18:00");
  });

  it("frees the slot of a cancelled appointment", async () => {
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: await at("11:00"),
      endsAt: await at("12:00"),
      status: "cancelled",
    });

    expect(await slots()).toHaveLength(14);
  });

  it("keeps the slot of completed and no-show appointments occupied", async () => {
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: await at("10:00"),
      endsAt: await at("11:00"),
      status: "completed",
    });
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: await at("14:00"),
      endsAt: await at("15:00"),
      status: "no_show",
    });

    const result = await slots();
    expect(result).not.toContain("10:00");
    expect(result).not.toContain("14:00");
  });
});

describe("booking window", () => {
  it("applies the minimum notice", async () => {
    await updateSettings(business.id, { minimum_booking_notice_minutes: 120 });

    // 09:50 + 2 h = 11:50: 11:30 is too early, 12:00 is the first start.
    expect(await slots({ now: await at("09:50") })).toEqual([
      "12:00",
      "14:00",
      "14:30",
      "15:00",
      "15:30",
      "16:00",
      "16:30",
      "17:00",
      "17:30",
      "18:00",
    ]);
    // 10:10 + 2 h = 12:10: 12:30 would end after 13:00, so the morning is gone.
    expect((await slots({ now: await at("10:10") }))[0]).toBe("14:00");
  });

  it("never offers a past slot", async () => {
    expect(await slots({ now: await at("16:00") })).toEqual([
      "16:00",
      "16:30",
      "17:00",
      "17:30",
      "18:00",
    ]);
  });

  it("applies the maximum advance in whole local days", async () => {
    await updateSettings(business.id, { maximum_booking_advance_days: 10 });

    // Now = 1 June 02:00 in Paris: 11 June is the last bookable day, entirely.

    expect(await slots({ date: "2030-06-11" })).toHaveLength(14);
    expect(await slots({ date: "2030-06-12" })).toEqual([]);
  });
});

describe("time zones", () => {
  it("interprets hours in the business zone, not in Paris or UTC", async () => {
    const newYork = await createBusiness(owner.userId, {
      timezone: "America/New_York",
      settings: {
        minimum_booking_notice_minutes: 0,
        slot_interval_minutes: 60,
      },
    });
    const nyService = await createService(newYork.id, { durationMinutes: 60 });
    await setWeeklyHours(newYork.id, everyDay(["09:00", "11:00"]));

    const { rows } = await db.query<{ starts_at: Date }>(
      `select starts_at from private.available_slots($1, $2, $3::date, $4::timestamptz)`,
      [newYork.id, nyService, DAY, NOW],
    );

    // 09:00 EDT (UTC−4) = 13:00 UTC.
    expect(rows.map((row) => row.starts_at.toISOString())).toEqual([
      "2030-06-12T13:00:00.000Z",
      "2030-06-12T14:00:00.000Z",
    ]);
  });

  it("handles the spring DST change (no 02:xx local time exists)", async () => {
    await setWeeklyHours(business.id, everyDay(["01:00", "05:00"]));

    // 2030-03-31: Paris jumps from 02:00 to 03:00; the range lasts 3 real
    // hours. 01:30 CET + 60 minutes = 03:30 CEST, a valid 60-minute slot.
    expect(
      await slots({ date: "2030-03-31", now: "2030-03-01T00:00Z" }),
    ).toEqual(["01:00", "01:30", "03:00", "03:30", "04:00"]);
  });

  it("handles the autumn DST change (the 02:xx hour happens twice)", async () => {
    await updateSettings(business.id, { slot_interval_minutes: 60 });
    await setWeeklyHours(business.id, everyDay(["01:00", "04:00"]));

    // 2030-10-27: Paris goes back from 03:00 to 02:00; the range lasts 4 hours.
    const { rows } = await db.query<{ starts_at: Date }>(
      `select starts_at from private.available_slots($1, $2, $3::date, $4::timestamptz)`,
      [business.id, service, "2030-10-27", "2030-10-01T00:00Z"],
    );

    expect(rows.map((row) => row.starts_at.toISOString())).toEqual([
      "2030-10-26T23:00:00.000Z", // 01:00 CEST
      "2030-10-27T00:00:00.000Z", // 02:00 CEST
      "2030-10-27T01:00:00.000Z", // 02:00 CET
      "2030-10-27T02:00:00.000Z", // 03:00 CET
    ]);
  });

  describe("local times made invalid by a DST change (Europe/Paris)", () => {
    // Rule: a nonexistent local time is shifted forward by the gap (PostgreSQL
    // `AT TIME ZONE`), an ambiguous one takes the later instant (standard
    // time), and a range left empty or inverted is ignored for that day only.
    const utcSlots = async (date: string, now: string) => {
      const { rows } = await db.query<{ starts_at: Date }>(
        `select starts_at from private.available_slots($1, $2, $3::date, $4::timestamptz)`,
        [business.id, service, date, now],
      );
      return rows.map((row) => row.starts_at.toISOString());
    };

    it("ignores a range inside the spring gap and keeps the other ranges", async () => {
      // 2027-03-28 (Sunday): 02:00 → 03:00; 02:30–03:00 does not exist.
      await setWeeklyHours(business.id, [
        [0, "02:30", "03:00"],
        [0, "09:00", "11:00"],
      ]);

      expect(
        await slots({ date: "2027-03-28", now: "2027-03-01T00:00Z" }),
      ).toEqual(["09:00", "09:30", "10:00"]);
    });

    it("never fails the day, even if every range is inside the gap", async () => {
      await setWeeklyHours(business.id, [
        [0, "02:00", "02:30"],
        [0, "02:30", "03:00"],
      ]);

      expect(
        await slots({ date: "2027-03-28", now: "2027-03-01T00:00Z" }),
      ).toEqual([]);
    });

    it("shifts a nonexistent start forward by the gap", async () => {
      const short = await createService(business.id, { durationMinutes: 30 });
      await setWeeklyHours(business.id, [[0, "02:30", "04:00"]]);

      // 02:30 does not exist → 03:30 CEST; the range is 03:30–04:00.
      const { rows } = await db.query<{ local: string }>(
        `select to_char(starts_at at time zone 'Europe/Paris', 'HH24:MI') as local
         from private.available_slots($1, $2, '2027-03-28', '2027-03-01T00:00Z')`,
        [business.id, short],
      );
      expect(rows.map((row) => row.local)).toEqual(["03:30"]);
    });

    it("uses the later occurrence of an ambiguous autumn time", async () => {
      await updateSettings(business.id, { slot_interval_minutes: 30 });
      const short = await createService(business.id, { durationMinutes: 30 });
      // 2027-10-31 (Sunday): 03:00 CEST → 02:00 CET; 02:xx happens twice.
      await setWeeklyHours(business.id, [
        [0, "02:00", "03:00"],
        [0, "09:00", "10:00"],
      ]);

      const { rows } = await db.query<{ starts_at: Date }>(
        `select starts_at from private.available_slots($1, $2, '2027-10-31', '2027-10-01T00:00Z')`,
        [business.id, short],
      );

      expect(rows.map((row) => row.starts_at.toISOString())).toEqual([
        "2027-10-31T01:00:00.000Z", // 02:00 CET (second occurrence)
        "2027-10-31T01:30:00.000Z", // 02:30 CET
        "2027-10-31T08:00:00.000Z", // 09:00 CET
        "2027-10-31T08:30:00.000Z", // 09:30 CET
      ]);
    });

    it("lets the booking transaction validate slots on a DST day", async () => {
      await setWeeklyHours(business.id, [
        [0, "02:30", "03:00"],
        [0, "09:00", "10:00"],
      ]);

      const { rows } = await db.query<{ count: number }>(
        `select count(*)::int as count
         from private.compute_available_slots(
           $1, '2027-03-28', '2027-03-01T00:00Z', 'Europe/Paris', 60, 30, 0, 0, 365)`,
        [business.id],
      );

      expect(rows[0]).toEqual({ count: 1 });
      expect(await utcSlots("2027-03-28", "2027-03-01T00:00Z")).toEqual([
        "2027-03-28T07:00:00.000Z", // 09:00 CEST
      ]);
    });
  });

  it("rejects an unknown IANA time zone", async () => {
    await expect(
      db.query(
        "update public.businesses set timezone = 'Mars/Olympus' where id = $1",
        [business.id],
      ),
    ).rejects.toMatchObject({ message: "invalid_timezone" });
  });
});
