import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  insertAppointment,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
  type OpenTransaction,
} from "./support/transactions";

// Atomic "replace" operations, isolation-level requirements and lock order of
// the schedule coordination (migration 20260928190000). Every scenario uses
// distinct PostgreSQL connections.

const DATE = dateInDays(25);

let owner: Professional;
let business: TestBusiness;
let service: string;

function local(time: string) {
  return zonedLocalToUtc(`${DATE}T${time}`, business.timezone).toISOString();
}

type Range = [number, string, string];

function replaceIn(
  transaction: OpenTransaction,
  businessId: string,
  ranges: Range[],
) {
  return transaction.connection.query(
    "select * from public.replace_business_hours($1, $2)",
    [
      businessId,
      JSON.stringify(
        ranges.map(([weekday, starts_at, ends_at]) => ({
          weekday,
          starts_at,
          ends_at,
        })),
      ),
    ],
  );
}

async function hoursOf(businessId: string) {
  const { rows } = await db.query<{ range: string }>(
    `select weekday || ' ' || to_char(starts_at, 'HH24:MI') || '-' || to_char(ends_at, 'HH24:MI') as range
     from public.business_hours where business_id = $1 order by weekday, starts_at`,
    [businessId],
  );

  return rows.map((row) => row.range);
}

const ownerTransaction = (isolation?: "repeatable read" | "serializable") =>
  openTransaction({ role: "authenticated", userId: owner.userId, isolation });

function bookIn(transaction: OpenTransaction, time: string, email: string) {
  return transaction.connection.query(
    `select appointment_id from public.create_public_booking(
       p_slug => $1, p_service_id => $2, p_starts_at => $3,
       p_first_name => 'Cliente', p_email => $4)`,
    [business.slug, service, local(time), email],
  );
}

function blockIn(
  transaction: OpenTransaction,
  startsAt: string,
  endsAt: string,
) {
  return transaction.connection.query(
    `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
     values ($1, 'blocked', $2, $3)`,
    [business.id, local(startsAt), local(endsAt)],
  );
}

async function scheduleState() {
  const { rows } = await db.query<{
    appointments: number;
    blocks: number;
    overlaps: number;
  }>(
    `select
       (select count(*)::int from public.appointments
         where business_id = $1 and status <> 'cancelled') as appointments,
       (select count(*)::int from public.availability_exceptions
         where business_id = $1 and kind in ('closed', 'blocked')) as blocks,
       (select count(*)::int
          from public.appointments a
          join public.availability_exceptions e
            on e.business_id = a.business_id
           and e.kind in ('closed', 'blocked')
           and e.starts_at < a.ends_at and e.ends_at > a.starts_at
         where a.business_id = $1 and a.status <> 'cancelled') as overlaps`,
    [business.id],
  );

  return rows[0]!;
}

beforeAll(async () => {
  owner = await createProfessional("locking");
});

beforeEach(async () => {
  business = await createBusiness(owner.userId, {
    settings: { slot_interval_minutes: 15, minimum_booking_notice_minutes: 0 },
  });
  service = await createService(business.id, { durationMinutes: 60 });
});

describe("replace_business_hours is an atomic replacement", () => {
  const MORNING: Range[] = [[1, "09:00", "12:00"]];
  const AFTERNOON: Range[] = [[1, "14:00", "18:00"]];

  // `firstStarter` runs its replacement first and holds the lock; the other
  // one starts afterwards and must wait, then fully replace.
  it.each([
    ["T1 starts before T2", MORNING, AFTERNOON],
    ["T2 starts before T1", AFTERNOON, MORNING],
  ])(
    "on an empty schedule, %s: the last serialised call wins, never a merge",
    async (_label, first, second) => {
      const t1 = await ownerTransaction();
      const t2 = await ownerTransaction();

      await replaceIn(t1, business.id, first);
      const secondResult = outcome(replaceIn(t2, business.id, second));
      await waitUntilBlocked(t2.pid);

      await closeTransaction(t1, "commit");
      expect(await secondResult).toBe("ok");
      await closeTransaction(t2, "commit");

      expect(await hoursOf(business.id)).toEqual(
        second.map(([weekday, start, end]) => `${weekday} ${start}-${end}`),
      );
    },
  );

  it("replaces a non-empty schedule completely under concurrency", async () => {
    await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
    const t1 = await ownerTransaction();
    const t2 = await ownerTransaction();

    await replaceIn(t1, business.id, MORNING);
    const secondResult = outcome(replaceIn(t2, business.id, AFTERNOON));
    await waitUntilBlocked(t2.pid);
    await closeTransaction(t1, "commit");
    expect(await secondResult).toBe("ok");
    await closeTransaction(t2, "commit");

    expect(await hoursOf(business.id)).toEqual(["1 14:00-18:00"]);
  });

  it("keeps only the waiting call's schedule when the first one rolls back", async () => {
    await setWeeklyHours(business.id, [[3, "10:00", "11:00"]]);
    const t1 = await ownerTransaction();
    const t2 = await ownerTransaction();

    await replaceIn(t1, business.id, MORNING);
    const secondResult = outcome(replaceIn(t2, business.id, AFTERNOON));
    await waitUntilBlocked(t2.pid);
    await closeTransaction(t1, "rollback");
    expect(await secondResult).toBe("ok");
    await closeTransaction(t2, "commit");

    expect(await hoursOf(business.id)).toEqual(["1 14:00-18:00"]);
  });

  it("restores the previous schedule when the only call rolls back", async () => {
    await setWeeklyHours(business.id, [[3, "10:00", "11:00"]]);
    const t1 = await ownerTransaction();
    await replaceIn(t1, business.id, MORNING);
    await closeTransaction(t1, "rollback");

    expect(await hoursOf(business.id)).toEqual(["3 10:00-11:00"]);
  });

  it("never blocks replacements of two different businesses", async () => {
    const other = await createBusiness(owner.userId);
    const t1 = await ownerTransaction();
    const t2 = await ownerTransaction();

    await replaceIn(t1, business.id, MORNING);
    // T1 still holds business' lock; the other business is not affected.
    await expect(replaceIn(t2, other.id, AFTERNOON)).resolves.toBeDefined();
    await closeTransaction(t2, "commit");
    await closeTransaction(t1, "commit");

    expect(await hoursOf(business.id)).toEqual(["1 09:00-12:00"]);
    expect(await hoursOf(other.id)).toEqual(["1 14:00-18:00"]);
  });

  it("is the only write path for API roles (no direct DML)", async () => {
    for (const statement of [
      "insert into public.business_hours (business_id, weekday, starts_at, ends_at) values ($1, 2, '09:00', '10:00')",
      "update public.business_hours set ends_at = '23:00' where business_id = $1",
      "delete from public.business_hours where business_id = $1",
    ]) {
      const t = await ownerTransaction();
      const result = await outcome(
        t.connection.query(statement, [business.id]),
      );
      await closeTransaction(t, "rollback");
      expect(result).toMatch(/permission denied/);
    }
  });
});

describe("reorder_services is an atomic rewrite", () => {
  it("applies exactly the last serialised order, never a mix", async () => {
    const second = await createService(business.id, { name: "B" });
    const third = await createService(business.id, { name: "C" });
    const ids = [service, second, third];

    const reorderIn = (t: OpenTransaction, order: string[]) =>
      t.connection.query("select public.reorder_services($1, $2)", [
        business.id,
        order,
      ]);

    const t1 = await ownerTransaction();
    const t2 = await ownerTransaction();
    await reorderIn(t1, [ids[2]!, ids[1]!, ids[0]!]);
    const secondResult = outcome(reorderIn(t2, [ids[1]!, ids[0]!, ids[2]!]));
    await waitUntilBlocked(t2.pid);
    await closeTransaction(t1, "commit");
    expect(await secondResult).toBe("ok");
    await closeTransaction(t2, "commit");

    const { rows } = await db.query<{ id: string }>(
      "select id from public.services where business_id = $1 order by display_order",
      [business.id],
    );
    expect(rows.map((row) => row.id)).toEqual([ids[1], ids[0], ids[2]]);
  });
});

describe("isolation level of schedule writes", () => {
  beforeEach(async () => {
    await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
  });

  describe("READ COMMITTED: a snapshot older than the concurrent commit is refreshed", () => {
    it("booking after a block committed during its transaction is refused", async () => {
      const booking = await openTransaction({ role: "anon" });
      // Any statement establishes the snapshot (anon cannot read tables).
      await booking.connection.query("select 1");

      const blocking = await ownerTransaction();
      await blockIn(blocking, "10:30", "11:30");
      await closeTransaction(blocking, "commit");

      expect(await outcome(bookIn(booking, "10:00", "late@x.test"))).toBe(
        "slot_unavailable",
      );
      await closeTransaction(booking, "rollback");
      expect(await scheduleState()).toEqual({
        appointments: 0,
        blocks: 1,
        overlaps: 0,
      });
    });

    it("block after a booking committed during its transaction is refused", async () => {
      const blocking = await ownerTransaction();
      await blocking.connection.query(
        "select count(*) from public.availability_exceptions",
      );

      const booking = await openTransaction({ role: "anon" });
      await bookIn(booking, "10:00", "first@x.test");
      await closeTransaction(booking, "commit");

      expect(await outcome(blockIn(blocking, "10:30", "11:30"))).toBe(
        "schedule_conflict",
      );
      await closeTransaction(blocking, "rollback");
      expect(await scheduleState()).toEqual({
        appointments: 1,
        blocks: 0,
        overlaps: 0,
      });
    });
  });

  describe.each(["repeatable read", "serializable"] as const)(
    "%s: explicitly refused before any data is written",
    (isolation) => {
      it("booking with a snapshot taken before a block was committed", async () => {
        const booking = await openTransaction({ role: "anon", isolation });
        // Any statement establishes the snapshot (anon cannot read tables).
        await booking.connection.query("select 1");

        const blocking = await ownerTransaction();
        await blockIn(blocking, "10:30", "11:30");
        await closeTransaction(blocking, "commit");

        expect(await outcome(bookIn(booking, "10:00", "late@x.test"))).toBe(
          "unsupported_isolation_level",
        );
        await closeTransaction(booking, "rollback");
        expect(await scheduleState()).toEqual({
          appointments: 0,
          blocks: 1,
          overlaps: 0,
        });
      });

      it("block with a snapshot taken before a booking was committed", async () => {
        const blocking = await ownerTransaction(isolation);
        await blocking.connection.query(
          "select count(*) from public.appointments",
        );

        const booking = await openTransaction({ role: "anon" });
        await bookIn(booking, "10:00", "first@x.test");
        await closeTransaction(booking, "commit");

        expect(await outcome(blockIn(blocking, "10:30", "11:30"))).toBe(
          "unsupported_isolation_level",
        );
        await closeTransaction(blocking, "rollback");
        expect(await scheduleState()).toEqual({
          appointments: 1,
          blocks: 0,
          overlaps: 0,
        });
      });

      it("block waiting behind a concurrent booking", async () => {
        const booking = await openTransaction({ role: "anon" });
        await bookIn(booking, "10:00", "first@x.test");

        const blocking = await ownerTransaction(isolation);
        // Refused immediately, without even waiting for the lock.
        expect(await outcome(blockIn(blocking, "10:30", "11:30"))).toBe(
          "unsupported_isolation_level",
        );
        await closeTransaction(blocking, "rollback");
        await closeTransaction(booking, "commit");
        expect(await scheduleState()).toEqual({
          appointments: 1,
          blocks: 0,
          overlaps: 0,
        });
      });

      it("raw appointment write and schedule replacement", async () => {
        const client = await createClientRecord(
          business.id,
          `raw-${isolation.length}@x.test`,
        );
        const t = await openTransaction({ isolation });
        const result = await outcome(
          t.connection.query(
            `insert into public.appointments (
               business_id, client_id, service_id, starts_at, ends_at,
               service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot)
             values ($1, $2, $3, $4, $5, 'x', 60, 0)`,
            [business.id, client, service, local("15:00"), local("16:00")],
          ),
        );
        await closeTransaction(t, "rollback");
        expect(result).toBe("unsupported_isolation_level");

        const owner2 = await ownerTransaction(isolation);
        expect(await outcome(replaceIn(owner2, business.id, []))).toBe(
          "unsupported_isolation_level",
        );
        await closeTransaction(owner2, "rollback");
        expect(await hoursOf(business.id)).toHaveLength(7);
      });

      it("still allows writes that only free time", async () => {
        const booked = await openTransaction({ role: "anon" });
        const { rows } = await bookIn(booked, "10:00", "free@x.test");
        await closeTransaction(booked, "commit");
        const blockId = (
          await db.query<{ id: string }>(
            `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
             values ($1, 'blocked', $2, $3) returning id`,
            [business.id, local("14:00"), local("15:00")],
          )
        ).rows[0]!.id;

        const t = await openTransaction({ isolation });
        await t.connection.query(
          "update public.appointments set status = 'cancelled' where id = $1",
          [rows[0].appointment_id],
        );
        await t.connection.query(
          "delete from public.availability_exceptions where id = $1",
          [blockId],
        );
        await closeTransaction(t, "commit");

        expect(await scheduleState()).toEqual({
          appointments: 0,
          blocks: 0,
          overlaps: 0,
        });
      });
    },
  );
});

describe("lock order: schedule lock first, then business rows", () => {
  it("a booking and a settings/service edit never deadlock, in both orders", async () => {
    await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));

    // Edit first (row lock), booking second (schedule lock, then waits).
    const edit = await openTransaction();
    await edit.connection.query(
      "update public.business_settings set buffer_minutes = 5 where business_id = $1",
      [business.id],
    );
    const booking = await openTransaction({ role: "anon" });
    const bookingResult = outcome(bookIn(booking, "10:00", "a@x.test"));
    await waitUntilBlocked(booking.pid);
    await closeTransaction(edit, "commit");
    expect(await bookingResult).toBe("ok");
    await closeTransaction(booking, "commit");

    // Booking first, edit second.
    const booking2 = await openTransaction({ role: "anon" });
    await bookIn(booking2, "14:00", "b@x.test");
    const edit2 = await openTransaction();
    const editResult = outcome(
      edit2.connection.query(
        "update public.services set price_cents = 1 where id = $1",
        [service],
      ),
    );
    await waitUntilBlocked(edit2.pid);
    await closeTransaction(booking2, "commit");
    expect(await editResult).toBe("ok");
    await closeTransaction(edit2, "commit");

    expect((await scheduleState()).appointments).toBe(2);
  });

  it("a booking and a schedule replacement serialise without deadlock", async () => {
    await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
    const booking = await openTransaction({ role: "anon" });
    await bookIn(booking, "10:00", "a@x.test");

    const replace = await ownerTransaction();
    const replaceResult = outcome(
      replaceIn(replace, business.id, [[1, "09:00", "12:00"]]),
    );
    await waitUntilBlocked(replace.pid);
    await closeTransaction(booking, "commit");
    expect(await replaceResult).toBe("ok");
    await closeTransaction(replace, "commit");

    const { rows } = await db.query(
      "select count(*)::int as count from public.appointments where business_id = $1",
      [business.id],
    );
    expect(rows[0]).toEqual({ count: 1 });
  });

  it("raw appointment insert waits for the schedule lock like any other write", async () => {
    await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
    const client = await createClientRecord(business.id, "raw@x.test");
    const blocking = await ownerTransaction();
    await blockIn(blocking, "15:00", "16:00");

    const insert = outcome(
      insertAppointment({
        businessId: business.id,
        clientId: client,
        serviceId: service,
        startsAt: local("15:30"),
        endsAt: local("16:30"),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await closeTransaction(blocking, "commit");

    expect(await insert).toBe("schedule_conflict");
    expect((await scheduleState()).overlaps).toBe(0);
  });
});
