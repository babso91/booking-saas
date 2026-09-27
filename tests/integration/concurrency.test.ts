import type pg from "pg";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  anonClient,
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

// Double booking must be impossible even when the availability re-check of
// two transactions runs before either inserts. These tests create exactly that
// interleaving and verify that PostgreSQL (exclusion constraint
// `appointments_no_overlap`) lets only one of them commit.

const DATE = dateInDays(21);

let owner: Professional;
let business: TestBusiness;
let service: string;

function local(time: string) {
  return zonedLocalToUtc(`${DATE}T${time}`, business.timezone).toISOString();
}

async function openAnonTransaction() {
  const connection = await db.connect();
  const { rows } = await connection.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );

  await connection.query("begin");
  await connection.query("set local role anon");

  return { connection, pid: rows[0]!.pid };
}

function book(connection: pg.PoolClient, startsAt: string, email: string) {
  return connection.query(
    `select appointment_id
     from public.create_public_booking(
       p_slug => $1, p_service_id => $2, p_starts_at => $3,
       p_first_name => 'Cliente', p_email => $4
     )`,
    [business.slug, service, startsAt, email],
  );
}

/** Resolves once backend `pid` is waiting on a lock held by another transaction. */
async function waitUntilBlocked(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await db.query(
      `select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    );

    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Backend ${pid} never blocked on a lock`);
}

async function countAppointments() {
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count from public.appointments
     where business_id = $1 and status <> 'cancelled'`,
    [business.id],
  );

  return rows[0]!.count;
}

beforeAll(async () => {
  owner = await createProfessional("concurrency");
});

beforeEach(async () => {
  business = await createBusiness(owner.userId, {
    settings: { slot_interval_minutes: 15, buffer_minutes: 0 },
  });
  service = await createService(business.id, { durationMinutes: 60 });
  await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
});

describe("concurrent public bookings", () => {
  it("lets only one of two interleaved overlapping bookings commit", async () => {
    const first = await openAnonTransaction();
    const second = await openAnonTransaction();

    try {
      // T1 books 10:00–11:00 and keeps its transaction open.
      await book(first.connection, local("10:00"), "first@x.test");

      // T2 wants 10:30–11:30. Its snapshot cannot see T1's row, so the
      // availability re-check inside the function passes: a plain
      // "check then insert" would create a double booking here. The insert
      // instead waits on the exclusion constraint.
      const secondResult = book(
        second.connection,
        local("10:30"),
        "second@x.test",
      ).then(
        () => "committed",
        (error: { message: string }) => error.message,
      );
      await waitUntilBlocked(second.pid);

      await first.connection.query("commit");

      expect(await secondResult).toBe("slot_unavailable");
      await second.connection.query("rollback");
    } finally {
      first.connection.release();
      second.connection.release();
    }

    expect(await countAppointments()).toBe(1);
  });

  it("gives the slot to the waiting transaction when the first one rolls back", async () => {
    const first = await openAnonTransaction();
    const second = await openAnonTransaction();

    try {
      await book(first.connection, local("10:00"), "first@x.test");
      const secondResult = book(
        second.connection,
        local("10:00"),
        "second@x.test",
      );
      await waitUntilBlocked(second.pid);

      await first.connection.query("rollback");

      await expect(secondResult).resolves.toBeDefined();
      await second.connection.query("commit");
    } finally {
      first.connection.release();
      second.connection.release();
    }

    const { rows } = await db.query(
      `select c.email from public.appointments a
       join public.clients c on c.id = a.client_id and c.business_id = a.business_id
       where a.business_id = $1`,
      [business.id],
    );
    expect(rows).toEqual([{ email: "second@x.test" }]);
  });

  function burst(times: string[]) {
    return Promise.allSettled(
      times.map((time, index) =>
        // A fresh client per request, like distinct visitors.
        createPublicBooking(anonClient(), {
          slug: business.slug,
          serviceId: service,
          startsAt: local(time),
          firstName: "Cliente",
          email: `burst-${time.replace(":", "")}-${index}@x.test`,
        }),
      ),
    );
  }

  it("accepts exactly one of 15 simultaneous API calls for the same slot", async () => {
    const results = await burst(Array.from({ length: 15 }, () => "10:00"));

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected.map((result) => result.reason.code)).toEqual(
      Array.from({ length: 14 }, () => "slot_unavailable"),
    );
    expect(await countAppointments()).toBe(1);
  });

  it("never stores overlapping appointments from simultaneous partially overlapping calls", async () => {
    // 60-minute service: each start overlaps its neighbours.
    const results = await burst([
      "09:15",
      "09:30",
      "09:45",
      "10:00",
      "10:15",
      "10:30",
      "10:45",
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(
      `select count(*)::int as overlaps from public.appointments a
       join public.appointments b
         on a.business_id = b.business_id and a.id < b.id
        and a.occupied_window && b.occupied_window
       where a.business_id = $1 and a.status <> 'cancelled' and b.status <> 'cancelled'`,
      [business.id],
    );
    expect(rows[0]).toEqual({ overlaps: 0 });
    expect(await countAppointments()).toBe(fulfilled.length);
  });
});

describe("the exclusion constraint itself", () => {
  // Protects every present and future write path, not only the public RPC.
  let clientId: string;

  beforeEach(async () => {
    clientId = await createClientRecord(business.id, "raw@x.test");
  });

  it("rejects overlapping raw inserts, buffer included", async () => {
    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: local("10:00"),
      endsAt: local("11:00"),
      bufferMinutes: 15,
    });

    await expect(
      insertAppointment({
        businessId: business.id,
        clientId,
        serviceId: service,
        startsAt: local("11:00"),
        endsAt: local("12:00"),
      }),
    ).rejects.toMatchObject({ code: "23P01" });

    await expect(
      insertAppointment({
        businessId: business.id,
        clientId,
        serviceId: service,
        startsAt: local("11:15"),
        endsAt: local("12:15"),
      }),
    ).resolves.toBeDefined();
  });

  it("rejects re-confirming a cancelled appointment whose slot was re-booked", async () => {
    const cancelled = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: local("14:00"),
      endsAt: local("15:00"),
      status: "cancelled",
    });
    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: local("14:30"),
      endsAt: local("15:30"),
    });

    await expect(
      db.query(
        "update public.appointments set status = 'confirmed' where id = $1",
        [cancelled],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("derives the occupied window from trusted columns only", async () => {
    const id = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: local("16:00"),
      endsAt: local("17:00"),
      bufferMinutes: 10,
    });

    await db.query(
      `update public.appointments
       set occupied_window = tstzrange(starts_at, starts_at + interval '1 minute')
       where id = $1`,
      [id],
    );

    const { rows } = await db.query<{ upper: Date }>(
      "select upper(occupied_window) as upper from public.appointments where id = $1",
      [id],
    );
    expect(rows[0]!.upper.toISOString()).toBe(
      new Date(Date.parse(local("17:00")) + 10 * 60_000).toISOString(),
    );
  });

  it("does not constrain appointments of different businesses", async () => {
    const other = await createBusiness(owner.userId);
    const otherService = await createService(other.id);
    const otherClient = await createClientRecord(other.id, "raw@x.test");

    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: local("09:00"),
      endsAt: local("10:00"),
    });

    await expect(
      insertAppointment({
        businessId: other.id,
        clientId: otherClient,
        serviceId: otherService,
        startsAt: local("09:00"),
        endsAt: local("10:00"),
      }),
    ).resolves.toBeDefined();
  });
});
