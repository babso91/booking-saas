import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import {
  createAvailabilityException,
  updateAvailabilityException,
} from "@/features/availability/data/schedule";
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
  updateSettings,
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

// Coordination between bookings and professional schedule changes, and
// consistency of the values a booking is validated and stored with.
//
// V1 rule: a `closed`/`blocked` period may never overlap a non-cancelled
// appointment. A conflicting block is refused (`schedule_conflict`); existing
// appointments are never moved or cancelled automatically.

const DATE = dateInDays(18);

let owner: Professional;
let business: TestBusiness;
let service: string;

function local(time: string, date = DATE) {
  return zonedLocalToUtc(`${date}T${time}`, business.timezone).toISOString();
}

const context = () => ({
  businessId: business.id,
  timezone: business.timezone,
});

function block(
  kind: "blocked" | "closed" | "open_override",
  startsAt: string,
  endsAt: string,
) {
  return createAvailabilityException(owner.client, context(), {
    kind,
    startsAt: `${DATE}T${startsAt}`,
    endsAt: `${DATE}T${endsAt}`,
    reason: null,
  });
}

function book(time: string, email: string, serviceId = service) {
  return createPublicBooking(anonClient(), {
    slug: business.slug,
    serviceId,
    startsAt: local(time),
    firstName: "Cliente",
    email,
  });
}

/** Booking RPC inside an open transaction (anonymous caller). */
function bookIn(transaction: OpenTransaction, time: string, email: string) {
  return transaction.connection.query(
    `select appointment_id from public.create_public_booking(
       p_slug => $1, p_service_id => $2, p_starts_at => $3,
       p_first_name => 'Cliente', p_email => $4)`,
    [business.slug, service, local(time), email],
  );
}

/** Block insertion inside an open transaction (signed-in owner, RLS on). */
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
  owner = await createProfessional("coordination");
});

beforeEach(async () => {
  business = await createBusiness(owner.userId, {
    settings: { slot_interval_minutes: 15, buffer_minutes: 0 },
  });
  service = await createService(business.id, { durationMinutes: 60 });
  await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
});

describe("blocks and existing appointments", () => {
  it("refuses a block overlapping an existing appointment", async () => {
    await book("10:00", "client@x.test");

    await expect(block("blocked", "10:30", "12:00")).rejects.toMatchObject({
      code: "schedule_conflict",
    });
    await expect(block("closed", "00:00", "23:59")).rejects.toMatchObject({
      code: "schedule_conflict",
    });
    expect(await scheduleState()).toEqual({
      appointments: 1,
      blocks: 0,
      overlaps: 0,
    });
  });

  it("accepts blocks adjacent to an appointment, even with a buffer", async () => {
    await updateSettings(business.id, { buffer_minutes: 30 });
    await book("10:00", "client@x.test");

    await expect(block("blocked", "09:00", "10:00")).resolves.toBeDefined();
    await expect(block("blocked", "11:00", "12:00")).resolves.toBeDefined();
    expect(await scheduleState()).toEqual({
      appointments: 1,
      blocks: 2,
      overlaps: 0,
    });
  });

  it("accepts an exceptional opening over an appointment (it adds time)", async () => {
    await book("10:00", "client@x.test");

    await expect(
      block("open_override", "08:00", "12:00"),
    ).resolves.toBeDefined();
  });

  it("refuses moving or re-kinding a block onto an appointment", async () => {
    await book("10:00", "client@x.test");
    const moved = await block("blocked", "14:00", "15:00");
    const opening = await block("open_override", "07:00", "12:00");

    await expect(
      updateAvailabilityException(owner.client, context(), moved.id, {
        kind: "blocked",
        startsAt: `${DATE}T10:45`,
        endsAt: `${DATE}T11:15`,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "schedule_conflict" });
    await expect(
      updateAvailabilityException(owner.client, context(), opening.id, {
        kind: "closed",
        startsAt: `${DATE}T07:00`,
        endsAt: `${DATE}T12:00`,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "schedule_conflict" });

    // Moving it to a free period still works.
    await expect(
      updateAvailabilityException(owner.client, context(), moved.id, {
        kind: "blocked",
        startsAt: `${DATE}T16:00`,
        endsAt: `${DATE}T17:00`,
        reason: null,
      }),
    ).resolves.toMatchObject({ localStartsAt: `${DATE}T16:00` });
    expect((await scheduleState()).overlaps).toBe(0);
  });

  it("ignores cancelled appointments", async () => {
    const booking = await book("10:00", "client@x.test");
    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [booking.appointmentId],
    );

    await expect(block("blocked", "10:00", "11:00")).resolves.toBeDefined();

    // …and never lets a cancelled appointment come back inside the block.
    await expect(
      db.query(
        "update public.appointments set status = 'confirmed' where id = $1",
        [booking.appointmentId],
      ),
    ).rejects.toMatchObject({ message: "schedule_conflict" });
  });

  it("does not reveal another tenant's appointments", async () => {
    await book("10:00", "client@x.test");
    const intruder = await createProfessional("coordination-intruder");

    const { error } = await intruder.client
      .from("availability_exceptions")
      .insert({
        business_id: business.id,
        kind: "blocked",
        starts_at: local("10:00"),
        ends_at: local("11:00"),
      });

    // Refused by RLS, never by the overlap check (which would leak a booking).
    expect(error?.code).toBe("42501");
  });
});

describe("appointments and existing blocks", () => {
  it("refuses a public booking inside a block", async () => {
    await block("blocked", "10:30", "11:00");

    await expect(book("10:00", "client@x.test")).rejects.toMatchObject({
      code: "slot_unavailable",
    });
  });

  it("refuses any appointment write inside a block, whatever the code path", async () => {
    await block("closed", "12:00", "14:00");
    const client = await createClientRecord(business.id, "raw@x.test");

    await expect(
      insertAppointment({
        businessId: business.id,
        clientId: client,
        serviceId: service,
        startsAt: local("13:00"),
        endsAt: local("14:00"),
      }),
    ).rejects.toMatchObject({ message: "schedule_conflict" });

    const id = await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: local("15:00"),
      endsAt: local("16:00"),
    });
    await expect(
      db.query(
        `update public.appointments
         set starts_at = $2, ends_at = $3 where id = $1`,
        [id, local("11:30"), local("12:30")],
      ),
    ).rejects.toMatchObject({ message: "schedule_conflict" });
  });
});

describe("concurrent booking and block", () => {
  it("booking first: the concurrent block waits, then is refused", async () => {
    const booking = await openTransaction({ role: "anon" });
    const blocking = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });

    await bookIn(booking, "10:00", "first@x.test");
    const blockResult = outcome(blockIn(blocking, "10:30", "11:30"));
    await waitUntilBlocked(blocking.pid);

    await closeTransaction(booking, "commit");
    expect(await blockResult).toBe("schedule_conflict");
    await closeTransaction(blocking, "rollback");

    expect(await scheduleState()).toEqual({
      appointments: 1,
      blocks: 0,
      overlaps: 0,
    });
  });

  it("block first: the concurrent booking waits, then is refused", async () => {
    const blocking = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });
    const booking = await openTransaction({ role: "anon" });

    await blockIn(blocking, "10:30", "11:30");
    const bookingResult = outcome(bookIn(booking, "10:00", "first@x.test"));
    await waitUntilBlocked(booking.pid);

    await closeTransaction(blocking, "commit");
    expect(await bookingResult).toBe("slot_unavailable");
    await closeTransaction(booking, "rollback");

    expect(await scheduleState()).toEqual({
      appointments: 0,
      blocks: 1,
      overlaps: 0,
    });
  });

  it("the waiting side succeeds when the first one rolls back (both orders)", async () => {
    const booking = await openTransaction({ role: "anon" });
    const blocking = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });

    await bookIn(booking, "10:00", "first@x.test");
    const blockResult = outcome(blockIn(blocking, "10:30", "11:30"));
    await waitUntilBlocked(blocking.pid);
    await closeTransaction(booking, "rollback");
    expect(await blockResult).toBe("ok");
    await closeTransaction(blocking, "commit");

    const blocking2 = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });
    const booking2 = await openTransaction({ role: "anon" });
    await blockIn(blocking2, "14:00", "15:00");
    const bookingResult = outcome(bookIn(booking2, "14:30", "second@x.test"));
    await waitUntilBlocked(booking2.pid);
    await closeTransaction(blocking2, "rollback");
    expect(await bookingResult).toBe("ok");
    await closeTransaction(booking2, "commit");

    expect(await scheduleState()).toEqual({
      appointments: 1,
      blocks: 1,
      overlaps: 0,
    });
  });

  it("moving a block while a booking is in flight cannot create an overlap", async () => {
    const moved = await block("blocked", "16:00", "17:00");
    const booking = await openTransaction({ role: "anon" });
    const moving = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });

    await bookIn(booking, "10:00", "first@x.test");
    const moveResult = outcome(
      moving.connection.query(
        `update public.availability_exceptions set starts_at = $2, ends_at = $3
         where id = $1`,
        [moved.id, local("10:30"), local("11:30")],
      ),
    );
    await waitUntilBlocked(moving.pid);

    await closeTransaction(booking, "commit");
    expect(await moveResult).toBe("schedule_conflict");
    await closeTransaction(moving, "rollback");

    expect((await scheduleState()).overlaps).toBe(0);
  });

  it("keeps the schedule consistent under simultaneous API calls", async () => {
    const times = [
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ];

    const results = await Promise.all(
      times.flatMap((time, index) => {
        const end = `${String(Number(time.slice(0, 2)) + 1).padStart(2, "0")}:00`;
        return [
          outcome(book(time, `burst-${index}@x.test`)),
          outcome(block("blocked", time, end)),
        ];
      }),
    );

    // For each hour exactly one of the two competing writes survived.
    for (let index = 0; index < times.length; index += 1) {
      const pair = [results[2 * index], results[2 * index + 1]];
      expect(pair.filter((result) => result === "ok")).toHaveLength(1);
    }

    const state = await scheduleState();
    expect(state.overlaps).toBe(0);
    expect(state.appointments + state.blocks).toBe(times.length);
  });
});

describe("booking uses one consistent set of values", () => {
  let client: string;

  beforeEach(async () => {
    client = await createClientRecord(business.id, "existing@x.test");
    // Existing appointment 10:30–11:30.
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: local("10:30"),
      endsAt: local("11:30"),
    });
  });

  async function bookedRow(appointmentId: string) {
    const { rows } = await db.query(
      `select duration_minutes_snapshot as duration,
              buffer_minutes_snapshot as buffer,
              extract(epoch from ends_at - starts_at)::int / 60 as length,
              extract(epoch from upper(occupied_window) - ends_at)::int / 60 as tail
       from public.appointments where id = $1`,
      [appointmentId],
    );

    return rows[0];
  }

  it("uses a duration changed (60 → 30) before it locks the service", async () => {
    const editor = await openTransaction();
    await editor.connection.query(
      "update public.services set duration_minutes = 30 where id = $1",
      [service],
    );

    // 10:00 + 60 min would overlap 10:30; 10:00 + 30 min fits exactly.
    const booking = await openTransaction({ role: "anon" });
    const result = bookIn(booking, "10:00", "new@x.test");
    await waitUntilBlocked(booking.pid);
    await closeTransaction(editor, "commit");

    const { rows } = await result;
    await closeTransaction(booking, "commit");

    expect(await bookedRow(rows[0].appointment_id)).toEqual({
      duration: 30,
      buffer: 0,
      length: 30,
      tail: 0,
    });
  });

  it("refuses a slot that a duration change (30 → 60) made unavailable", async () => {
    await db.query(
      "update public.services set duration_minutes = 30 where id = $1",
      [service],
    );
    const editor = await openTransaction();
    await editor.connection.query(
      "update public.services set duration_minutes = 60 where id = $1",
      [service],
    );

    const booking = await openTransaction({ role: "anon" });
    const result = outcome(bookIn(booking, "10:00", "new@x.test"));
    await waitUntilBlocked(booking.pid);
    await closeTransaction(editor, "commit");

    expect(await result).toBe("slot_unavailable");
    await closeTransaction(booking, "rollback");
  });

  it("keeps the validated duration when the service changes during the booking", async () => {
    const booking = await openTransaction({ role: "anon" });
    const { rows } = await bookIn(booking, "09:00", "new@x.test");

    // The edit waits for the booking to commit instead of changing its values.
    const editor = await openTransaction();
    const edit = outcome(
      editor.connection.query(
        "update public.services set duration_minutes = 30 where id = $1",
        [service],
      ),
    );
    await waitUntilBlocked(editor.pid);
    await closeTransaction(booking, "commit");
    expect(await edit).toBe("ok");
    await closeTransaction(editor, "commit");

    expect(await bookedRow(rows[0].appointment_id)).toEqual({
      duration: 60,
      buffer: 0,
      length: 60,
      tail: 0,
    });
  });

  it("validates and stores the buffer committed before the booking reads it", async () => {
    const editor = await openTransaction();
    await editor.connection.query(
      "update public.business_settings set buffer_minutes = 30 where business_id = $1",
      [business.id],
    );

    // 09:30–10:30 fits with buffer 0 but not with 30 (next appointment 10:30).
    const refused = await openTransaction({ role: "anon" });
    const refusedResult = outcome(bookIn(refused, "09:30", "refused@x.test"));
    await waitUntilBlocked(refused.pid);
    await closeTransaction(editor, "commit");
    expect(await refusedResult).toBe("slot_unavailable");
    await closeTransaction(refused, "rollback");

    const accepted = await book("12:00", "accepted@x.test");
    expect(await bookedRow(accepted.appointmentId)).toEqual({
      duration: 60,
      buffer: 30,
      length: 60,
      tail: 30,
    });
  });

  it("keeps the validated buffer when settings change during the booking", async () => {
    const booking = await openTransaction({ role: "anon" });
    const { rows } = await bookIn(booking, "09:00", "new@x.test");

    const editor = await openTransaction();
    const edit = outcome(
      editor.connection.query(
        "update public.business_settings set buffer_minutes = 45 where business_id = $1",
        [business.id],
      ),
    );
    await waitUntilBlocked(editor.pid);
    await closeTransaction(booking, "commit");
    expect(await edit).toBe("ok");
    await closeTransaction(editor, "commit");

    expect(await bookedRow(rows[0].appointment_id)).toEqual({
      duration: 60,
      buffer: 0,
      length: 60,
      tail: 0,
    });
  });

  it("validates against the slot grid committed before the booking reads it", async () => {
    const editor = await openTransaction();
    await editor.connection.query(
      "update public.business_settings set slot_interval_minutes = 60 where business_id = $1",
      [business.id],
    );

    // 12:15 is on the 15-minute grid but not on the new 60-minute grid.
    const booking = await openTransaction({ role: "anon" });
    const result = outcome(bookIn(booking, "12:15", "grid@x.test"));
    await waitUntilBlocked(booking.pid);
    await closeTransaction(editor, "commit");

    expect(await result).toBe("slot_unavailable");
    await closeTransaction(booking, "rollback");
  });
});
