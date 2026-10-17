import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";
import {
  runEmailOutbox,
  type EmailWorkerOptions,
} from "@/features/notifications/data/worker";
import { mailpitTransport } from "@/features/notifications/transport/mailpit";
import { MemoryTransport } from "@/features/notifications/transport/memory";
import type { EmailTransport } from "@/features/notifications/transport/types";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  anonClient,
  bookingClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  insertAppointment,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Transactional emails against real PostgreSQL: the outbox rules (trigger
// and claim), the worker (src/features/notifications) with an in-memory
// transport, and Mailpit for a real local delivery. Every worker run is
// limited to the business under test (the test database holds other
// files' queued emails).

const FROM = "Booking <reservations@example.test>";
const APP_URL = "http://localhost:3000";

type EmailRow = {
  id: string;
  type: string;
  status: string;
  recipient_email: string;
  scheduled_for: Date;
  next_attempt_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  provider_message_id: string | null;
  claim_id: string | null;
  lease_until: Date | null;
};

type AttemptRow = {
  attempt_number: number;
  outcome: string | null;
  error_code: string | null;
  provider_message_id: string | null;
};

let owner: Professional;

beforeAll(async () => {
  owner = await createProfessional("emails");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(
  options: { timezone?: string; name?: string } = {},
): Promise<{ business: TestBusiness; service: string }> {
  const business = await createBusiness(owner.userId, {
    name: options.name ?? "Studio Mila Lashes",
    timezone: options.timezone ?? "Europe/Paris",
    settings: {
      slot_interval_minutes: 15,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 60,
    },
  });
  const service = await createService(business.id, {
    name: "Volume mixte",
    durationMinutes: 90,
    priceCents: 8500,
  });
  await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
  return { business, service };
}

function local(business: TestBusiness, date: string, time: string) {
  return zonedLocalToUtc(`${date}T${time}`, business.timezone).toISOString();
}

async function book(
  business: TestBusiness,
  service: string,
  startsAt: string,
  email = `lea-${randomUUID().slice(0, 6)}@example.test`,
  requestId = randomUUID(),
) {
  return createPublicBooking(
    bookingClient(),
    createPublicBookingSchema.parse({
      slug: business.slug,
      serviceId: service,
      startsAt,
      firstName: "Léa",
      email,
      requestId,
    }),
    randomIp(),
  );
}

async function emailsOf(appointmentId: string): Promise<EmailRow[]> {
  const { rows } = await db.query<EmailRow>(
    `select id, type::text, status::text, recipient_email::text, scheduled_for,
            next_attempt_at, attempt_count, last_error, provider_message_id,
            claim_id, lease_until
     from public.email_events
     where appointment_id = $1
     order by created_at, type`,
    [appointmentId],
  );
  return rows;
}

async function emailOf(appointmentId: string, type: string) {
  const rows = (await emailsOf(appointmentId)).filter(
    (row) => row.type === type,
  );
  return rows;
}

async function attemptsOf(emailId: string): Promise<AttemptRow[]> {
  const { rows } = await db.query<AttemptRow>(
    `select attempt_number, outcome, error_code, provider_message_id
     from public.email_delivery_attempts
     where email_event_id = $1
     order by attempt_number`,
    [emailId],
  );
  return rows;
}

/** The moment of the email has come (as if the clock had reached it). */
async function makeDue(emailId: string) {
  await db.query(
    `update public.email_events
     set scheduled_for = now() - interval '1 second', next_attempt_at = null
     where id = $1`,
    [emailId],
  );
}

function worker(
  transport: EmailTransport,
  businessId: string,
  options: EmailWorkerOptions = {},
) {
  return runEmailOutbox(
    { admin: bookingClient(), transport, from: FROM, appUrl: APP_URL },
    { businessId, ...options },
  );
}

/** The agenda RPCs, as the professional (the real write paths). */
async function moveAppointment(
  businessId: string,
  appointmentId: string,
  startsAt: string,
  clientId?: string,
) {
  const { rows } = await db.query<{
    version: number;
    service_id: string;
    client_id: string;
  }>(
    "select version, service_id, client_id from public.appointments where id = $1",
    [appointmentId],
  );
  const current = rows[0]!;
  const { error } = await owner.client.rpc("agenda_update_appointment", {
    p_business_id: businessId,
    p_appointment_id: appointmentId,
    p_expected_version: current.version,
    p_service_id: current.service_id,
    p_client_id: clientId ?? current.client_id,
    p_starts_at: startsAt,
  });
  if (error) throw error;
}

async function setStatus(
  businessId: string,
  appointmentId: string,
  status: "cancelled" | "completed" | "no_show" | "confirmed",
) {
  const { rows } = await db.query<{ version: number }>(
    "select version from public.appointments where id = $1",
    [appointmentId],
  );
  const { error } = await owner.client.rpc("agenda_set_appointment_status", {
    p_business_id: businessId,
    p_appointment_id: appointmentId,
    p_expected_version: rows[0]!.version,
    p_status: status,
  });
  if (error) throw error;
}

async function reminderAt(startsAt: string, timezone: string) {
  const { rows } = await db.query<{ at: Date }>(
    "select private.email_reminder_at($1, $2) as at",
    [startsAt, timezone],
  );
  return rows[0]!.at.toISOString();
}

describe("booking confirmation", () => {
  it("is queued by the booking and delivered with the appointment's details", async () => {
    const { business, service } = await setup();
    const date = dateInDays(5);
    const startsAt = local(business, date, "10:30");
    const booking = await book(business, service, startsAt, "lea@example.test");

    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    expect(confirmation).toMatchObject({
      status: "pending",
      recipient_email: "lea@example.test",
    });

    const transport = new MemoryTransport();
    const result = await worker(transport, business.id);
    expect(result).toMatchObject({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
    });
    expect(transport.sent).toHaveLength(1);

    const message = transport.sent[0]!;
    expect(message.to).toBe("lea@example.test");
    expect(message.from).toBe(FROM);
    expect(message.replyTo).toBe(`${business.slug}@test.local`);
    expect(message.idempotencyKey).toBe(confirmation!.id);
    expect(message.subject).toBe("Rendez-vous confirmé – Studio Mila Lashes");
    expect(message.text).toContain("Bonjour Léa,");
    expect(message.text).toContain("Prestation : Volume mixte");
    expect(message.text).toMatch(/Date : \w+ \d{1,2} \w+ \d{4} à 10 h 30/u);
    expect(message.text).toContain("Durée : 1 h 30");
    expect(message.text).toMatch(/Prix : 85,00\s€/u);
    expect(message.text).toContain(`${APP_URL}/b/${business.slug}`);
    expect(message.text).toContain("(Europe/Paris)");
    expect(message.html).toContain("Volume mixte");

    const [sent] = await emailOf(booking.appointmentId, "booking_confirmation");
    expect(sent).toMatchObject({
      status: "sent",
      attempt_count: 1,
      provider_message_id: "memory-1",
      claim_id: null,
      lease_until: null,
      last_error: null,
    });
    expect(await attemptsOf(sent!.id)).toEqual([
      {
        attempt_number: 1,
        outcome: "sent",
        error_code: null,
        provider_message_id: "memory-1",
      },
    ]);

    // Nothing more is due: a second run sends nothing.
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    expect(transport.sent).toHaveLength(1);
  });

  it("a replayed booking request queues nothing more", async () => {
    const { business, service } = await setup();
    const requestId = randomUUID();
    const startsAt = local(business, dateInDays(6), "11:00");
    const first = await book(
      business,
      service,
      startsAt,
      "r@example.test",
      requestId,
    );
    const again = await book(
      business,
      service,
      startsAt,
      "r@example.test",
      requestId,
    );
    expect(again.replayed).toBe(true);
    expect(again.appointmentId).toBe(first.appointmentId);
    const types = (await emailsOf(first.appointmentId)).map((row) => row.type);
    expect(types.sort()).toEqual([
      "appointment_reminder",
      "booking_confirmation",
    ]);
  });
});

describe("reminder the day before", () => {
  it("is scheduled at 18:00 the day before, business time, and delivered once due", async () => {
    const { business, service } = await setup();
    const startsAt = local(business, dateInDays(4), "09:00");
    const booking = await book(business, service, startsAt);

    const [reminder] = await emailOf(
      booking.appointmentId,
      "appointment_reminder",
    );
    expect(reminder!.status).toBe("pending");
    expect(reminder!.scheduled_for.toISOString()).toBe(
      await reminderAt(startsAt, business.timezone),
    );
    expect(reminder!.scheduled_for.toISOString()).toBe(
      local(business, dateInDays(3), "18:00"),
    );

    const transport = new MemoryTransport();
    await worker(transport, business.id); // the confirmation only
    expect(transport.sent.map((m) => m.subject)).toEqual([
      "Rendez-vous confirmé – Studio Mila Lashes",
    ]);

    await makeDue(reminder!.id);
    await worker(transport, business.id);
    expect(transport.sent.map((m) => m.subject)).toEqual([
      "Rendez-vous confirmé – Studio Mila Lashes",
      "Rappel de votre rendez-vous – Studio Mila Lashes",
    ]);
    expect(transport.sent[1]!.text).toContain("à 9 h");
  });

  it("follows the business's time zone across clock changes", async () => {
    // Far-future dates: independent of the day the suite runs.
    const cases: [string, string, string, string][] = [
      // Paris, autumn: the reminder day (25 Oct 2026) is the change itself.
      [
        "Europe/Paris",
        "2026-10-26T09:00",
        "2026-10-25T17:00:00.000Z",
        "fall back",
      ],
      // Paris, spring.
      [
        "Europe/Paris",
        "2027-03-29T09:00",
        "2027-03-28T16:00:00.000Z",
        "spring forward",
      ],
      // Havana changes at midnight.
      [
        "America/Havana",
        "2026-11-02T10:00",
        "2026-11-01T23:00:00.000Z",
        "midnight change",
      ],
      [
        "America/Los_Angeles",
        "2027-03-15T08:00",
        "2027-03-15T01:00:00.000Z",
        "west of UTC",
      ],
      // Just after midnight: the evening before its own date.
      [
        "Asia/Tokyo",
        "2027-01-10T00:30",
        "2027-01-09T09:00:00.000Z",
        "after midnight",
      ],
    ];
    for (const [timezone, wall, expected, label] of cases) {
      const startsAt = zonedLocalToUtc(wall, timezone).toISOString();
      expect(await reminderAt(startsAt, timezone), label).toBe(expected);
    }

    // Through the trigger, on appointments of a far-future autumn week.
    const { business, service } = await setup({ timezone: "Europe/Paris" });
    const clientId = await createClientRecord(business.id, "dst@example.test");
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2027-11-01T09:00:00Z",
      endsAt: "2027-11-01T10:30:00Z",
    });
    const [reminder] = await emailOf(appointmentId, "appointment_reminder");
    // 31 Oct 2027 is the autumn change in Europe: 18:00 CET = 17:00 UTC.
    expect(reminder!.scheduled_for.toISOString()).toBe(
      "2027-10-31T17:00:00.000Z",
    );
    expect(reminder!.recipient_email).toBe("dst@example.test");
  });

  it("is not queued when its moment has already passed", async () => {
    const { business, service } = await setup();
    const clientId = await createClientRecord(business.id, "soon@example.test");
    const { rows } = await db.query<{ at: Date }>(
      "select date_trunc('minute', now() + interval '3 hours') as at",
    );
    const startsAt = rows[0]!.at;
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 90 * 60_000).toISOString(),
    });
    expect(await emailOf(appointmentId, "appointment_reminder")).toEqual([]);
  });

  it("is not queued for a customer without an email address", async () => {
    const { business, service } = await setup();
    const { rows } = await db.query<{ id: string }>(
      `insert into public.clients (business_id, first_name, phone)
       values ($1, 'Sans email', '0600000000') returning id`,
      [business.id],
    );
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId: rows[0]!.id,
      serviceId: service,
      startsAt: "2027-06-01T08:00:00Z",
      endsAt: "2027-06-01T09:30:00Z",
    });
    expect(await emailsOf(appointmentId)).toEqual([]);
  });

  it("follows a change of the business's time zone made after it was queued", async () => {
    const { business, service } = await setup({ timezone: "Europe/Paris" });
    const clientId = await createClientRecord(business.id, "tz@example.test");
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2027-06-10T08:00:00Z",
      endsAt: "2027-06-10T09:30:00Z",
    });
    const [queued] = await emailOf(appointmentId, "appointment_reminder");
    expect(queued!.scheduled_for.toISOString()).toBe(
      "2027-06-09T16:00:00.000Z",
    );

    await db.query(
      "update public.businesses set timezone = 'America/New_York' where id = $1",
      [business.id],
    );
    // At the former moment, the claim moves it to the new one, unsent.
    const { rows } = await db.query<{ items: unknown[] }>(
      `select private.email_outbox_claim_at(
         '2027-06-09T16:00:00Z', 20, 5, 120, $1) as items`,
      [business.id],
    );
    expect(rows[0]!.items).toEqual([]);
    const [moved] = await emailOf(appointmentId, "appointment_reminder");
    expect(moved).toMatchObject({ status: "pending", attempt_count: 0 });
    // 9 June 2027 18:00 in New York (EDT, UTC−4) = 22:00 UTC.
    expect(moved!.scheduled_for.toISOString()).toBe("2027-06-09T22:00:00.000Z");
  });

  it("is given up when the worker comes too late (less than an hour before)", async () => {
    const { business, service } = await setup();
    const clientId = await createClientRecord(business.id, "late@example.test");
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2027-07-01T08:00:00Z",
      endsAt: "2027-07-01T09:30:00Z",
    });
    await db.query(
      `select private.email_outbox_claim_at('2027-07-01T07:30:00Z', 20, 5, 120, $1)`,
      [business.id],
    );
    const [reminder] = await emailOf(appointmentId, "appointment_reminder");
    expect(reminder).toMatchObject({
      status: "cancelled",
      last_error: "reminder_too_late",
      attempt_count: 0,
    });
  });
});

describe("cancelled appointments", () => {
  it("never send their reminder; the customer is told of the cancellation", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(7), "15:00"),
      "cancel@example.test",
    );
    await setStatus(business.id, booking.appointmentId, "cancelled");

    const rows = await emailsOf(booking.appointmentId);
    expect(
      rows.map(({ type, status, last_error }) => ({
        type,
        status,
        last_error,
      })),
    ).toEqual([
      {
        type: "appointment_reminder",
        status: "cancelled",
        last_error: "appointment_cancelled",
      },
      {
        type: "booking_confirmation",
        status: "cancelled",
        last_error: "appointment_cancelled",
      },
      { type: "appointment_cancelled", status: "pending", last_error: null },
    ]);

    // Even forced due, the reminder is never claimed again.
    const reminder = rows.find((row) => row.type === "appointment_reminder")!;
    await makeDue(reminder.id);
    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.subject).toBe(
      "Rendez-vous annulé – Studio Mila Lashes",
    );
    expect(transport.sent[0]!.text).not.toContain("Prix");
    expect(transport.sent[0]!.text).toContain(
      `Pour reprendre rendez-vous : ${APP_URL}/b/${business.slug}`,
    );
  });

  it("a reminder already claimed when the appointment is cancelled is not delivered", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(8), "15:00"),
    );
    const [reminder] = await emailOf(
      booking.appointmentId,
      "appointment_reminder",
    );
    await db.query(
      "update public.email_events set status = 'sent' where appointment_id = $1 and type = 'booking_confirmation'",
      [booking.appointmentId],
    );
    await makeDue(reminder!.id);

    // A worker claims the reminder and dies; meanwhile the appointment is
    // cancelled. The next claim re-checks it against the appointment.
    const { data: claimed } = await bookingClient().rpc("email_outbox_claim", {
      p_business_id: business.id,
    });
    expect((claimed as unknown[]).length).toBe(1);
    await setStatus(business.id, booking.appointmentId, "cancelled");
    await db.query(
      "update public.email_events set lease_until = now() - interval '1 second' where id = $1",
      [reminder!.id],
    );

    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent.map((m) => m.subject)).toEqual([
      "Rendez-vous annulé – Studio Mila Lashes",
    ]);
    const [after] = await emailOf(
      booking.appointmentId,
      "appointment_reminder",
    );
    expect(after).toMatchObject({
      status: "cancelled",
      last_error: "appointment_cancelled",
    });
    expect((await attemptsOf(after!.id)).map((a) => a.outcome)).toEqual([
      "lease_expired",
    ]);
  });

  it("an appointment cancelled while its batch is being sent is not reminded", async () => {
    const { business, service } = await setup();
    const first = await book(
      business,
      service,
      local(business, dateInDays(26), "10:00"),
    );
    const second = await book(
      business,
      service,
      local(business, dateInDays(27), "10:00"),
    );
    await db.query(
      "update public.email_events set status = 'sent' where business_id = $1 and type = 'booking_confirmation'",
      [business.id],
    );
    const reminders = [
      ...(await emailOf(first.appointmentId, "appointment_reminder")),
      ...(await emailOf(second.appointmentId, "appointment_reminder")),
    ];
    for (const reminder of reminders) await makeDue(reminder.id);

    // Both reminders are claimed in one batch; while the first is being
    // sent, the professional cancels the other appointment.
    const memory = new MemoryTransport();
    let cancelledOther = false;
    const transport: EmailTransport = {
      name: "memory",
      async send(email, signal) {
        if (!cancelledOther) {
          cancelledOther = true;
          const other =
            email.idempotencyKey === reminders[0]!.id ? second : first;
          await setStatus(business.id, other.appointmentId, "cancelled");
        }
        return memory.send(email, signal);
      },
    };
    const result = await worker(transport, business.id);
    expect(result).toMatchObject({ claimed: 2, sent: 1, cancelled: 1 });
    expect(memory.sent).toHaveLength(1);
    const sentId = memory.sent[0]!.idempotencyKey;
    const skipped = reminders.find((reminder) => reminder.id !== sentId)!;
    const { rows } = await db.query<EmailRow>(
      "select status::text, last_error from public.email_events where id = $1",
      [skipped.id],
    );
    expect(rows[0]).toMatchObject({
      status: "cancelled",
      last_error: "appointment_cancelled",
    });
    expect(
      (await attemptsOf(skipped.id)).map((a) => [a.outcome, a.error_code]),
    ).toEqual([["cancelled", "appointment_cancelled"]]);
  });

  it("completed and no-show appointments drop their queued reminder without notice", async () => {
    const { business, service } = await setup();
    const clientId = await createClientRecord(business.id, "done@example.test");
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2027-08-01T08:00:00Z",
      endsAt: "2027-08-01T09:30:00Z",
    });
    await db.query(
      "update public.appointments set status = 'no_show' where id = $1",
      [appointmentId],
    );
    expect(
      (await emailsOf(appointmentId)).map(({ type, status, last_error }) => ({
        type,
        status,
        last_error,
      })),
    ).toEqual([
      {
        type: "appointment_reminder",
        status: "cancelled",
        last_error: "appointment_closed",
      },
    ]);
  });

  it("a past appointment cancelled afterwards sends nothing", async () => {
    const { business, service } = await setup();
    const clientId = await createClientRecord(business.id, "past@example.test");
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2025-01-01T08:00:00Z",
      endsAt: "2025-01-01T09:30:00Z",
    });
    await setStatus(business.id, appointmentId, "cancelled");
    expect(await emailsOf(appointmentId)).toEqual([]);
  });
});

describe("changed appointments", () => {
  it("a move before the confirmation went out: one confirmation, with the new time", async () => {
    const { business, service } = await setup();
    const date = dateInDays(9);
    const booking = await book(
      business,
      service,
      local(business, date, "10:00"),
    );
    const [oldReminder] = await emailOf(
      booking.appointmentId,
      "appointment_reminder",
    );

    const newStart = local(business, dateInDays(10), "16:15");
    await moveAppointment(business.id, booking.appointmentId, newStart);

    const rows = await emailsOf(booking.appointmentId);
    expect(rows.filter((row) => row.type === "appointment_changed")).toEqual(
      [],
    );
    const reminders = rows.filter((row) => row.type === "appointment_reminder");
    expect(
      reminders.map(({ id, status, last_error }) => ({
        id,
        status,
        last_error,
      })),
    ).toEqual([
      { id: oldReminder!.id, status: "cancelled", last_error: "rescheduled" },
      { id: expect.any(String), status: "pending", last_error: null },
    ]);
    expect(reminders[1]!.scheduled_for.toISOString()).toBe(
      await reminderAt(newStart, business.timezone),
    );

    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.subject).toContain("Rendez-vous confirmé");
    expect(transport.sent[0]!.text).toContain("à 16 h 15");
  });

  it("a move after the confirmation: one change notice per change, the latest only", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(11), "10:00"),
    );
    const transport = new MemoryTransport();
    await worker(transport, business.id); // the confirmation

    await moveAppointment(
      business.id,
      booking.appointmentId,
      local(business, dateInDays(11), "12:00"),
    );
    await moveAppointment(
      business.id,
      booking.appointmentId,
      local(business, dateInDays(12), "17:45"),
    );
    const changes = await emailOf(booking.appointmentId, "appointment_changed");
    expect(
      changes.map(({ status, last_error }) => ({ status, last_error })),
    ).toEqual([
      { status: "cancelled", last_error: "superseded" },
      { status: "pending", last_error: null },
    ]);

    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.subject).toBe(
      "Rendez-vous modifié – Studio Mila Lashes",
    );
    expect(transport.sent[1]!.text).toContain("à 17 h 45");

    // One reminder left, for the latest time.
    const reminders = (
      await emailOf(booking.appointmentId, "appointment_reminder")
    ).filter((row) => row.status === "pending");
    expect(reminders).toHaveLength(1);
  });

  it("an edit that changes nothing visible to the customer queues nothing", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(13), "10:00"),
    );
    const before = await emailsOf(booking.appointmentId);
    const { rows } = await db.query<{ version: number; client_id: string }>(
      "select version, client_id from public.appointments where id = $1",
      [booking.appointmentId],
    );
    const { error } = await owner.client.rpc("agenda_update_appointment", {
      p_business_id: business.id,
      p_appointment_id: booking.appointmentId,
      p_expected_version: rows[0]!.version,
      p_service_id: service,
      p_client_id: rows[0]!.client_id,
      p_internal_notes: "Préfère le matin",
    });
    expect(error).toBeNull();
    expect(await emailsOf(booking.appointmentId)).toEqual(before);
  });

  it("an appointment moved to another customer: nothing more for the former contact", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(14), "10:00"),
      "former@example.test",
    );
    const otherClient = await createClientRecord(
      business.id,
      "new@example.test",
      "Inès",
    );
    await moveAppointment(
      business.id,
      booking.appointmentId,
      local(business, dateInDays(14), "10:00"),
      otherClient,
    );
    const rows = await emailsOf(booking.appointmentId);
    expect(
      rows.map(({ type, status, last_error, recipient_email }) => ({
        type,
        status,
        last_error,
        recipient_email,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          type: "booking_confirmation",
          status: "cancelled",
          last_error: "recipient_changed",
          recipient_email: "former@example.test",
        },
        {
          type: "appointment_reminder",
          status: "cancelled",
          last_error: "recipient_changed",
          recipient_email: "former@example.test",
        },
        {
          type: "appointment_reminder",
          status: "pending",
          last_error: null,
          recipient_email: "new@example.test",
        },
      ]),
    );
    expect(rows.filter((row) => row.type === "appointment_changed")).toEqual(
      [],
    );
  });
});

describe("worker reliability", () => {
  async function bookMany(count: number) {
    const { business, service } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const booking = await book(
        business,
        service,
        local(business, dateInDays(15 + i), "10:00"),
      );
      const [confirmation] = await emailOf(
        booking.appointmentId,
        "booking_confirmation",
      );
      ids.push(confirmation!.id);
    }
    return { business, ids };
  }

  it("concurrent workers deliver each email exactly once to the transport", async () => {
    const { business, ids } = await bookMany(8);
    const transport = new MemoryTransport();
    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        worker(transport, business.id, { limit: 3, perBusiness: 3 }),
      ),
    );
    const again = await worker(transport, business.id, {
      limit: 20,
      perBusiness: 20,
    });
    const sentKeys = transport.sent.map((m) => m.idempotencyKey);
    expect(new Set(sentKeys).size).toBe(sentKeys.length);
    expect(sentKeys.sort()).toEqual([...ids].sort());
    expect(runs.reduce((sum, run) => sum + run.sent, 0) + again.sent).toBe(8);
    const { rows } = await db.query<{ status: string; n: number }>(
      `select status::text, count(*)::int as n from public.email_events
       where id = any($1) group by status`,
      [ids],
    );
    expect(rows).toEqual([{ status: "sent", n: 8 }]);
  });

  it("under contention, no email is ever claimed by two workers", async () => {
    // Many parallel claims over the same due emails: each claim's candidate
    // list is stale by the time it locks a row, which may have been claimed
    // and committed meanwhile; the claim must re-check it under its lock.
    const { business, service } = await setup();
    const clientId = await createClientRecord(business.id, "bulk@example.test");
    for (let i = 0; i < 40; i++) {
      const startsAt = new Date(Date.UTC(2027, 9, 1 + i, 8)).toISOString();
      await insertAppointment({
        businessId: business.id,
        clientId,
        serviceId: service,
        startsAt,
        endsAt: new Date(Date.UTC(2027, 9, 1 + i, 9, 30)).toISOString(),
      });
    }
    await db.query(
      `update public.email_events
       set scheduled_for = now() - interval '1 minute'
       where business_id = $1 and type = 'appointment_reminder'`,
      [business.id],
    );
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        bookingClient().rpc("email_outbox_claim", {
          p_business_id: business.id,
          p_limit: 20,
          p_per_business: 40,
        }),
      ),
    );
    const claimed = claims.flatMap(({ data, error }) => {
      expect(error).toBeNull();
      return (data as { id: string }[]).map((item) => item.id);
    });
    expect(claimed).toHaveLength(40);
    expect(new Set(claimed).size).toBe(40);
    const { rows } = await db.query<{ attempts: number }>(
      `select count(*)::int as attempts from public.email_delivery_attempts
       where business_id = $1`,
      [business.id],
    );
    expect(rows[0]!.attempts).toBe(40);
  });

  it("a claim abandoned by a crashed worker is delivered after its lease, with the same idempotency key", async () => {
    const { business, ids } = await bookMany(1);
    const { data } = await bookingClient().rpc("email_outbox_claim", {
      p_business_id: business.id,
    });
    const [lost] = data as { id: string; claimId: string }[];
    expect(lost!.id).toBe(ids[0]);

    // Lease still running: nobody else takes it.
    const transport = new MemoryTransport();
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });

    await db.query(
      "update public.email_events set lease_until = now() - interval '1 second' where id = $1",
      [lost!.id],
    );
    expect(await worker(transport, business.id)).toMatchObject({ sent: 1 });
    expect(transport.sent[0]!.idempotencyKey).toBe(lost!.id);
    expect(
      (await attemptsOf(lost!.id)).map((a) => [
        a.attempt_number,
        a.outcome,
        a.error_code,
      ]),
    ).toEqual([
      [1, "lease_expired", "lease_expired"],
      [2, "sent", null],
    ]);

    // The crashed worker wakes up: its claim is no longer current.
    const { data: completed } = await bookingClient().rpc(
      "email_outbox_complete",
      {
        p_id: lost!.id,
        p_claim_id: lost!.claimId,
        p_provider_message_id: "late-worker",
      },
    );
    expect(completed).toBe(false);
    const { data: failed } = await bookingClient().rpc("email_outbox_fail", {
      p_id: lost!.id,
      p_claim_id: lost!.claimId,
      p_error_code: "late",
    });
    expect(failed).toBeNull();
    const [row] = await db
      .query<EmailRow>(
        "select status::text, provider_message_id from public.email_events where id = $1",
        [lost!.id],
      )
      .then((result) => result.rows);
    expect(row).toMatchObject({
      status: "sent",
      provider_message_id: "memory-1",
    });
  });

  it("a temporary provider failure is retried with backoff, then delivered", async () => {
    const { business, ids } = await bookMany(1);
    const transport = new MemoryTransport();
    transport.failNext("provider_unavailable");
    expect(await worker(transport, business.id)).toMatchObject({
      retried: 1,
      sent: 0,
    });

    const { rows } = await db.query<EmailRow & { delay: number }>(
      `select status::text, attempt_count, last_error,
              extract(epoch from next_attempt_at - last_attempt_at)::int as delay
       from public.email_events where id = $1`,
      [ids[0]],
    );
    expect(rows[0]).toMatchObject({
      status: "pending",
      attempt_count: 1,
      last_error: "provider_unavailable",
    });
    expect(rows[0]!.delay).toBeGreaterThanOrEqual(59);
    expect(rows[0]!.delay).toBeLessThanOrEqual(61);

    // Not due yet.
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    await db.query(
      "update public.email_events set next_attempt_at = now() - interval '1 second' where id = $1",
      [ids[0]],
    );
    expect(await worker(transport, business.id)).toMatchObject({ sent: 1 });
    expect(
      (await attemptsOf(ids[0]!)).map((a) => [a.outcome, a.error_code]),
    ).toEqual([
      ["retry", "provider_unavailable"],
      ["sent", null],
    ]);
    expect(transport.attempts.map((m) => m.idempotencyKey)).toEqual([
      ids[0],
      ids[0],
    ]);
  });

  it("a timeout is a temporary failure", async () => {
    const { business, ids } = await bookMany(1);
    const transport = new MemoryTransport();
    transport.hangNext();
    expect(
      await worker(transport, business.id, { sendTimeoutMs: 200 }),
    ).toMatchObject({ retried: 1 });
    const [row] = (
      await db.query<EmailRow>(
        "select status::text, last_error from public.email_events where id = $1",
        [ids[0]],
      )
    ).rows;
    expect(row).toMatchObject({
      status: "pending",
      last_error: "provider_timeout",
    });
  });

  it("a permanent failure is given up at once", async () => {
    const { business, ids } = await bookMany(1);
    const transport = new MemoryTransport();
    transport.failNext("provider_rejected_422", true);
    expect(await worker(transport, business.id)).toMatchObject({ failed: 1 });
    const [row] = (
      await db.query<EmailRow>(
        "select status::text, last_error, next_attempt_at from public.email_events where id = $1",
        [ids[0]],
      )
    ).rows;
    expect(row).toMatchObject({
      status: "failed",
      last_error: "provider_rejected_422",
      next_attempt_at: null,
    });
    // A failed email is never claimed again, whatever its dates.
    await db.query(
      "update public.email_events set next_attempt_at = now() - interval '1 second', scheduled_for = now() - interval '1 second' where id = $1",
      [ids[0]],
    );
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    expect(transport.attempts).toHaveLength(1);
  });

  it("the attempts are limited", async () => {
    const { business, ids } = await bookMany(2);
    // The seventh failure is retried, the eighth is final.
    await db.query(
      "update public.email_events set attempt_count = 6 where id = any($1)",
      [ids],
    );
    const transport = new MemoryTransport();
    transport.failNext("provider_unavailable", false, 2);
    await worker(transport, business.id);
    let rows = (
      await db.query<EmailRow>(
        "select status::text, attempt_count from public.email_events where id = any($1)",
        [ids],
      )
    ).rows;
    expect(rows.map((r) => [r.status, r.attempt_count])).toEqual([
      ["pending", 7],
      ["pending", 7],
    ]);
    await db.query(
      "update public.email_events set next_attempt_at = now() - interval '1 second' where id = any($1)",
      [ids],
    );
    transport.failNext("provider_unavailable", false, 1);
    await worker(transport, business.id);
    rows = (
      await db.query<EmailRow>(
        "select id, status::text, attempt_count, last_error from public.email_events where id = any($1) order by status",
        [ids],
      )
    ).rows;
    expect(rows.map((r) => [r.status, r.attempt_count, r.last_error])).toEqual([
      ["failed", 8, "provider_unavailable"],
      ["sent", 8, null],
    ]);

    // An email already at the limit (e.g. its last claim expired) is
    // failed by the claim without any further attempt.
    const failed = rows.find((r) => r.status === "failed")!;
    await db.query(
      `update public.email_events
       set status = 'pending', next_attempt_at = now() - interval '1 second'
       where id = $1`,
      [failed.id],
    );
    const sentBefore = transport.attempts.length;
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    expect(transport.attempts.length).toBe(sentBefore);
    const [exhausted] = (
      await db.query<EmailRow>(
        "select status::text, last_error from public.email_events where id = $1",
        [failed.id],
      )
    ).rows;
    expect(exhausted).toMatchObject({
      status: "failed",
      last_error: "attempts_exhausted",
    });
  });

  it("a run out of time gives back what it claimed, without counting an attempt", async () => {
    const { business, ids } = await bookMany(2);
    const transport = new MemoryTransport();
    expect(await worker(transport, business.id, { budgetMs: 0 })).toMatchObject(
      { claimed: 2, released: 2, sent: 0 },
    );
    expect(transport.attempts).toEqual([]);
    const { rows } = await db.query<EmailRow>(
      "select status::text, attempt_count, claim_id from public.email_events where id = any($1)",
      [ids],
    );
    expect(rows.map((r) => [r.status, r.attempt_count, r.claim_id])).toEqual([
      ["pending", 0, null],
      ["pending", 0, null],
    ]);
    for (const id of ids) expect(await attemptsOf(id)).toEqual([]);
    expect(await worker(transport, business.id)).toMatchObject({ sent: 2 });
  });

  it("a business cannot send in bulk: past 300 attempts in 24 hours its emails wait", async () => {
    const { business, ids } = await bookMany(1);
    const other = await bookMany(1);
    // 300 attempts recorded today for this business (any of its emails).
    await db.query(
      `insert into public.email_delivery_attempts
         (business_id, email_event_id, attempt_number, claim_id, started_at, outcome)
       select $1, $2, n, gen_random_uuid(), now() - interval '1 hour', 'sent'
       from generate_series(1, 300) n`,
      [business.id, ids[0]],
    );
    const transport = new MemoryTransport();
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    const [waiting] = (
      await db.query<EmailRow>(
        "select status::text, attempt_count from public.email_events where id = $1",
        [ids[0]],
      )
    ).rows;
    expect(waiting).toMatchObject({ status: "pending", attempt_count: 0 });
    // Other businesses are not affected.
    expect(await worker(transport, other.business.id)).toMatchObject({
      sent: 1,
    });

    // Once the window has passed, the email goes.
    await db.query(
      "update public.email_delivery_attempts set started_at = now() - interval '25 hours' where business_id = $1",
      [business.id],
    );
    expect(await worker(transport, business.id)).toMatchObject({ sent: 1 });
  });

  it("stale news is not sent days later", async () => {
    const { business, ids } = await bookMany(1);
    await db.query(
      "update public.email_events set created_at = now() - interval '49 hours' where id = $1",
      [ids[0]],
    );
    const transport = new MemoryTransport();
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    expect(transport.attempts).toEqual([]);
    const [row] = (
      await db.query<EmailRow>(
        "select status::text, last_error from public.email_events where id = $1",
        [ids[0]],
      )
    ).rows;
    expect(row).toMatchObject({ status: "cancelled", last_error: "expired" });
  });
});

describe("security", () => {
  const workerFunctions = [
    ["email_outbox_claim", {}],
    ["email_outbox_complete", { p_id: randomUUID(), p_claim_id: randomUUID() }],
    [
      "email_outbox_fail",
      { p_id: randomUUID(), p_claim_id: randomUUID(), p_error_code: "x" },
    ],
    ["email_outbox_release", { p_id: randomUUID(), p_claim_id: randomUUID() }],
    ["email_outbox_verify", { p_id: randomUUID(), p_claim_id: randomUUID() }],
  ] as const;

  it("the worker functions are executable by the service role only", async () => {
    for (const [name, args] of workerFunctions) {
      for (const client of [anonClient(), owner.client]) {
        const { error } = await client.rpc(name, args as never);
        expect(error, name).not.toBeNull();
        expect(error!.code, name).toBe("42501");
      }
    }
    const { rows } = await db.query<{ role: string; allowed: boolean }>(
      `select r as role,
              has_function_privilege(r, 'private.email_outbox_claim_at(timestamptz, integer, integer, integer, uuid)', 'execute') as allowed
       from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows.every((row) => !row.allowed)).toBe(true);
  });

  it("members can read their outbox and attempts, never write them", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(20), "10:00"),
    );
    await worker(new MemoryTransport(), business.id);
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );

    const { data: visible } = await owner.client
      .from("email_delivery_attempts")
      .select("outcome")
      .eq("email_event_id", confirmation!.id);
    expect(visible).toEqual([{ outcome: "sent" }]);

    // A member cannot queue an email (an unauthorised send) …
    const { error: insertError } = await owner.client
      .from("email_events")
      .insert({
        business_id: business.id,
        type: "booking_confirmation",
        recipient_email: "victim@example.test",
        dedupe_key: `forged:${randomUUID()}`,
      });
    expect(insertError).not.toBeNull();
    // … nor make a cancelled or sent one deliverable again …
    const { data: updated } = await owner.client
      .from("email_events")
      .update({ status: "pending" })
      .eq("id", confirmation!.id)
      .select();
    expect(updated ?? []).toEqual([]);
    // … nor forge an attempt.
    const { error: attemptError } = await owner.client
      .from("email_delivery_attempts")
      .insert({
        business_id: business.id,
        email_event_id: confirmation!.id,
        attempt_number: 9,
        claim_id: randomUUID(),
        started_at: new Date().toISOString(),
      });
    expect(attemptError).not.toBeNull();
    const [row] = await emailOf(booking.appointmentId, "booking_confirmation");
    expect(row!.status).toBe("sent");
  });

  it("isolates businesses: no member reads another business's attempts, a business's worker run never claims another's", async () => {
    const a = await setup();
    const b = await setup();
    await book(
      a.business,
      a.service,
      local(a.business, dateInDays(21), "10:00"),
    );
    const bookingB = await book(
      b.business,
      b.service,
      local(b.business, dateInDays(21), "10:00"),
    );
    await worker(new MemoryTransport(), b.business.id);

    const stranger = await createProfessional("emails-stranger");
    await createBusiness(stranger.userId);
    const { data: attempts } = await stranger.client
      .from("email_delivery_attempts")
      .select("id")
      .eq("business_id", b.business.id);
    expect(attempts).toEqual([]);
    const { data: outbox } = await stranger.client
      .from("email_events")
      .select("id")
      .eq("business_id", b.business.id);
    expect(outbox).toEqual([]);

    const transport = new MemoryTransport();
    await worker(transport, a.business.id);
    expect(transport.sent).toHaveLength(1);
    const [confirmationB] = await emailOf(
      bookingB.appointmentId,
      "booking_confirmation",
    );
    expect(confirmationB!.status).toBe("sent");
    expect(transport.sent[0]!.idempotencyKey).not.toBe(confirmationB!.id);
  });

  it("an email carries the appointment's own data only, and logs carry no address nor content", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(22), "10:00"),
      "private@example.test",
    );
    const { rows } = await db.query<{ client_id: string }>(
      "select client_id from public.appointments where id = $1",
      [booking.appointmentId],
    );
    await db.query(
      "update public.appointments set internal_notes = 'SECRET-INTERNAL-NOTE' where id = $1",
      [booking.appointmentId],
    );
    await db.query(
      `insert into public.client_notes (business_id, client_id, content, created_by, updated_by)
       values ($1, $2, 'SECRET-CRM-NOTE', $3, $3)`,
      [business.id, rows[0]!.client_id, owner.userId],
    );
    await createClientRecord(
      business.id,
      "someone-else@example.test",
      "AUTRE-CLIENTE",
    );

    const lines: string[] = [];
    for (const method of ["info", "warn", "error", "log"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const transport = new MemoryTransport();
    transport.failNext("provider_unavailable");
    await worker(transport, business.id);
    await db.query(
      "update public.email_events set next_attempt_at = now() - interval '1 second' where appointment_id = $1 and status = 'pending' and type = 'booking_confirmation'",
      [booking.appointmentId],
    );
    await worker(transport, business.id);

    const message = transport.sent[0]!;
    for (const secret of [
      "SECRET-INTERNAL-NOTE",
      "SECRET-CRM-NOTE",
      "AUTRE-CLIENTE",
      "someone-else",
    ]) {
      expect(message.text).not.toContain(secret);
      expect(message.html).not.toContain(secret);
    }
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    expect(logged).not.toContain("private@example.test");
    expect(logged).not.toContain("Rendez-vous");
    expect(logged).not.toContain("Léa");
  });

  it("an invalid recipient is never handed to the transport", async () => {
    const { business, service } = await setup();
    // A customer record whose address carries a header injection (written
    // directly: the forms refuse it, the database must not trust it).
    const clientId = await createClientRecord(
      business.id,
      "x@example.test\r\nBcc: victim@example.test",
    );
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2027-09-01T08:00:00Z",
      endsAt: "2027-09-01T09:30:00Z",
    });
    const [reminder] = await emailOf(appointmentId, "appointment_reminder");
    expect(reminder!.recipient_email).toContain("\r\n");
    await makeDue(reminder!.id);

    const transport = new MemoryTransport();
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    expect(transport.attempts).toEqual([]);
    const [failed] = await emailOf(appointmentId, "appointment_reminder");
    expect(failed).toMatchObject({
      status: "failed",
      last_error: "invalid_recipient",
      attempt_count: 0,
    });
  });

  it("business data cannot inject headers nor markup", async () => {
    const { business, service } = await setup({
      name: "Studio <b>Mila</b>\r\nBcc: victim@example.test",
    });
    await book(business, service, local(business, dateInDays(24), "10:00"));
    const transport = new MemoryTransport();
    await worker(transport, business.id);
    const message = transport.sent[0]!;
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.html).not.toContain("<b>Mila</b>");
    expect(message.html).toContain("&lt;b&gt;Mila&lt;/b&gt;");
  });
});

describe("local delivery (Mailpit)", () => {
  it("delivers a confirmation to the local Mailpit", async () => {
    const mailpitUrl = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
    const { business, service } = await setup();
    const recipient = `mailpit-${randomUUID().slice(0, 8)}@example.test`;
    await book(
      business,
      service,
      local(business, dateInDays(25), "10:00"),
      recipient,
    );

    const result = await worker(mailpitTransport(mailpitUrl), business.id);
    expect(result).toMatchObject({ sent: 1 });

    const search = await fetch(
      `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${recipient}"`)}`,
    );
    const found = (await search.json()) as {
      messages: {
        ID: string;
        Subject: string;
        ReplyTo: { Address: string }[];
      }[];
    };
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]!.Subject).toBe(
      "Rendez-vous confirmé – Studio Mila Lashes",
    );
    expect(found.messages[0]!.ReplyTo[0]!.Address).toBe(
      `${business.slug}@test.local`,
    );
  });
});
