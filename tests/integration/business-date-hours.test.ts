import { beforeEach, describe, expect, it } from "vitest";

import {
  anonClient,
  createBusiness,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Opening hours for one date (Higani point 219). A tester's report of 21/11:
// usually open 18:00–20:00 on Tuesdays, she added 10:00–12:00 for one
// Tuesday and her 18:00–20:00 vanished from the online slots, while she
// wanted both. A date now holds several ranges; it still replaces the
// usual hours of its day (the editor starts from them), so rows saved by
// the previous version keep their meaning.

type Row = { starts_at: string; ends_at: string };
const range = (startsAt: string, endsAt: string): Row => ({
  starts_at: startsAt,
  ends_at: endsAt,
});

let owner: Professional;
let business: TestBusiness;
let service: string;
const day = dateInDays(9);

beforeEach(async () => {
  owner = await createProfessional("date-hours");
  business = await createBusiness(owner.userId, {
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 60,
    },
  });
  service = await createService(business.id, { durationMinutes: 60 });
  // Her usual day, whatever the weekday of the run.
  await setWeeklyHours(business.id, everyDay(["18:00", "20:00"]));
});

/** The online slots of the date, as wall-clock starts. */
async function slots() {
  const { rows } = await db.query<{ local_starts_at: string }>(
    "select local_starts_at from public.get_available_slots($1, $2, $3)",
    [business.slug, service, day],
  );
  return rows.map((row) => row.local_starts_at.slice(11, 16));
}

/** The ranges stored for the date. */
async function stored() {
  const { rows } = await db.query<Row>(
    `select to_char(starts_at, 'HH24:MI') as starts_at,
            to_char(ends_at, 'HH24:MI') as ends_at
       from public.business_date_hours
      where business_id = $1 and date = $2
      order by starts_at`,
    [business.id, day],
  );
  return rows;
}

function save(
  ranges: Row[] | null,
  expected: Row[] | null,
  who: Professional = owner,
) {
  return who.client.rpc("set_business_date_ranges", {
    p_business_id: business.id,
    p_date: day,
    p_ranges: ranges,
    p_expected: expected,
  });
}

describe("several opening ranges on one date", () => {
  it("her case: 10:00–12:00 added to her usual 18:00–20:00 keeps both online", async () => {
    expect(await slots()).toEqual(["18:00", "18:30", "19:00"]);

    // What the editor sends: the usual range it started from, plus hers.
    const saved = await save(
      [range("10:00", "12:00"), range("18:00", "20:00")],
      null,
    );
    expect(saved.error).toBeNull();
    expect(saved.data?.map((row) => row.starts_at)).toEqual([
      "10:00:00",
      "18:00:00",
    ]);
    expect(await slots()).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "18:00",
      "18:30",
      "19:00",
    ]);
    // Only that date: the next day keeps the usual hours.
    const { rows } = await db.query<{ local_starts_at: string }>(
      "select local_starts_at from public.get_available_slots($1, $2, $3)",
      [business.slug, service, dateInDays(10)],
    );
    expect(rows.map((row) => row.local_starts_at.slice(11, 16))).toEqual([
      "18:00",
      "18:30",
      "19:00",
    ]);
  });

  it("the date still replaces the day: a usual range she removed is not offered", async () => {
    expect((await save([range("10:00", "12:00")], null)).error).toBeNull();
    expect(await slots()).toEqual(["10:00", "10:30", "11:00"]);
  });

  it("restoring the usual hours removes every range of the date", async () => {
    await save([range("10:00", "12:00"), range("14:00", "16:00")], null);
    const restored = await save(null, [
      range("10:00", "12:00"),
      range("14:00", "16:00"),
    ]);
    expect(restored.error).toBeNull();
    expect(restored.data).toEqual([]);
    expect(await stored()).toEqual([]);
    expect(await slots()).toEqual(["18:00", "18:30", "19:00"]);
  });

  it("refuses overlapping ranges, an empty list and more than 12, writing nothing", async () => {
    await save([range("10:00", "12:00")], null);
    const before = await stored();

    for (const ranges of [
      [range("10:00", "12:00"), range("11:30", "13:00")],
      [range("10:00", "12:00"), range("10:00", "12:00")],
      [range("12:00", "10:00")],
      [],
      Array.from({ length: 13 }, (_, index) =>
        range(
          `${String(index).padStart(2, "0")}:00`,
          `${String(index).padStart(2, "0")}:30`,
        ),
      ),
    ]) {
      const refused = await save(ranges, before);
      expect(refused.error?.message, JSON.stringify(ranges)).toBe(
        "invalid_hours",
      );
    }
    expect(await stored()).toEqual(before);
    // Back to back is not an overlap; 24:00 closes at midnight.
    const adjacent = await save(
      [range("10:00", "12:00"), range("12:00", "24:00")],
      before,
    );
    expect(adjacent.error).toBeNull();
  });

  it("the database itself refuses two overlapping ranges on a date", async () => {
    await db.query(
      "insert into public.business_date_hours (business_id, date, starts_at, ends_at) values ($1, $2, '10:00', '12:00')",
      [business.id, day],
    );
    await expect(
      db.query(
        "insert into public.business_date_hours (business_id, date, starts_at, ends_at) values ($1, $2, '11:00', '13:00')",
        [business.id, day],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
    // Another date, or another business, is not concerned.
    await db.query(
      "insert into public.business_date_hours (business_id, date, starts_at, ends_at) values ($1, $2, '11:00', '13:00')",
      [business.id, dateInDays(11)],
    );
  });

  it("two tabs edited from the same read: the second is refused, not merged", async () => {
    await save([range("10:00", "12:00")], null);
    const read = await stored();

    const first = await save(
      [range("10:00", "12:00"), range("14:00", "15:00")],
      read,
    );
    expect(first.error).toBeNull();
    const second = await save(
      [range("10:00", "12:00"), range("18:00", "20:00")],
      read,
    );
    expect(second.error?.message).toBe("stale_business_hours");
    expect(await stored()).toEqual([
      range("10:00", "12:00"),
      range("14:00", "15:00"),
    ]);

    // A retry of the change already made (its answer lost) is answered.
    const retry = await save(
      [range("14:00", "15:00"), range("10:00", "12:00")],
      read,
    );
    expect(retry.error).toBeNull();
  });

  it("two tabs saving at the same moment from the same read: one wins, the other is refused", async () => {
    const results = await Promise.all([
      save([range("09:00", "10:00")], null),
      save([range("13:00", "14:00")], null),
    ]);
    const outcomes = results.map((result) => result.error?.message ?? "ok");
    expect(outcomes.sort()).toEqual(["ok", "stale_business_hours"]);
    expect(await stored()).toHaveLength(1);
  });

  it("the previous single-range call still works and never merges into several ranges", async () => {
    const single = await owner.client.rpc("set_business_date_hours", {
      p_business_id: business.id,
      p_date: day,
      p_starts_at: "10:00",
      p_ends_at: "12:00",
    });
    expect(single.error).toBeNull();
    expect(await stored()).toEqual([range("10:00", "12:00")]);

    await save(
      [range("10:00", "12:00"), range("18:00", "20:00")],
      [range("10:00", "12:00")],
    );
    // An old editor that read only 10:00–12:00 cannot overwrite both.
    const stale = await owner.client.rpc("set_business_date_hours", {
      p_business_id: business.id,
      p_date: day,
      p_starts_at: "09:00",
      p_ends_at: "11:00",
      p_expected_starts_at: "10:00",
      p_expected_ends_at: "12:00",
    });
    expect(stale.error?.message).toBe("stale_business_hours");
    expect(await stored()).toHaveLength(2);
  });

  it("another business's owner and anonymous callers change nothing", async () => {
    const intruder = await createProfessional("date-hours-intruder");
    await createBusiness(intruder.userId);
    const forged = await save([range("06:00", "07:00")], null, intruder);
    expect(forged.error?.message).toBe("forbidden");

    const anonymous = await anonClient().rpc("set_business_date_ranges", {
      p_business_id: business.id,
      p_date: day,
      p_ranges: [range("06:00", "07:00")],
      p_expected: null,
    });
    expect(anonymous.error).not.toBeNull();
    expect(await stored()).toEqual([]);
  });
});
