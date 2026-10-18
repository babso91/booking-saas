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
    // The confirmation went out: the customer knows of the appointment.
    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(1);
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
      { type: "booking_confirmation", status: "sent", last_error: null },
      { type: "appointment_cancelled", status: "pending", last_error: null },
    ]);

    // Even forced due, the reminder is never claimed again.
    const reminder = rows.find((row) => row.type === "appointment_reminder")!;
    await makeDue(reminder.id);
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.subject).toBe(
      "Rendez-vous annulé – Studio Mila Lashes",
    );
    expect(transport.sent[1]!.text).not.toContain("Prix");
    expect(transport.sent[1]!.text).toContain(
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
  it("a public booking moved before its confirmation went out: one change notice with every new detail, no confirmation", async () => {
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

    // She saw 10:00 confirmed on the booking page.
    const newStart = local(business, dateInDays(10), "16:15");
    await moveAppointment(business.id, booking.appointmentId, newStart);

    const rows = await emailsOf(booking.appointmentId);
    expect(
      rows
        .filter((row) => row.type !== "appointment_reminder")
        .map(({ type, status, last_error }) => [type, status, last_error]),
    ).toEqual([
      ["booking_confirmation", "cancelled", "superseded"],
      ["appointment_changed", "pending", null],
    ]);
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
    const notice = transport.sent[0]!;
    expect(notice.subject).toBe("Rendez-vous modifié – Studio Mila Lashes");
    // Reads on its own: every detail of the appointment as it now is.
    expect(notice.text).toContain("Établissement : Studio Mila Lashes");
    expect(notice.text).toContain("Prestation : Volume mixte");
    expect(notice.text).toContain("à 16 h 15");
    expect(notice.text).toContain("Durée : 1 h 30");
    expect(notice.text).toMatch(/Prix : 85,00\s€/u);
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
    [
      "email_outbox_prepare",
      {
        p_id: randomUUID(),
        p_claim_id: randomUUID(),
        p_appointment_version: 1,
        p_message: {},
      },
    ],
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

// ---------------------------------------------------------------------------
// Corrections after the independent audit of PR #22
// ---------------------------------------------------------------------------

type ClaimItem = {
  id: string;
  claimId: string;
  appointment: { version: number };
  message: unknown;
};

async function claimNow(businessId: string): Promise<ClaimItem[]> {
  const { data, error } = await bookingClient().rpc("email_outbox_claim", {
    p_business_id: businessId,
  });
  if (error) throw error;
  return data as ClaimItem[];
}

async function expireLease(emailId: string) {
  await db.query(
    "update public.email_events set lease_until = now() - interval '1 second' where id = $1",
    [emailId],
  );
}

async function retryNow(emailId: string) {
  await db.query(
    "update public.email_events set next_attempt_at = now() - interval '1 second' where id = $1",
    [emailId],
  );
}

async function emailRow(emailId: string) {
  const { rows } = await db.query<
    EmailRow & { first_submitted_at: Date | null; frozen: boolean }
  >(
    `select e.status::text, e.attempt_count, e.last_error, e.first_submitted_at,
            e.provider_message_id,
            exists (select 1 from private.email_renderings r where r.email_event_id = e.id) as frozen
     from public.email_events e where e.id = $1`,
    [emailId],
  );
  return rows[0]!;
}

describe("idempotent delivery (frozen message)", () => {
  it("a retry after a lost answer sends the same request; the provider delivers it once", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(30), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport({ idempotency: true });
    transport.acceptThenFailNext("provider_timeout");
    expect(await worker(transport, business.id)).toMatchObject({ retried: 1 });
    const afterTimeout = await emailRow(confirmation!.id);
    expect(afterTimeout).toMatchObject({ status: "pending", frozen: true });
    expect(afterTimeout.first_submitted_at).not.toBeNull();

    // The business renames itself before the retry: the retry still sends
    // the frozen request (a re-rendered one would be refused by Resend,
    // 409 invalid_idempotent_request).
    await db.query(
      "update public.businesses set name = 'Nouveau nom' where id = $1",
      [business.id],
    );
    await retryNow(confirmation!.id);
    expect(await worker(transport, business.id)).toMatchObject({ sent: 1 });

    expect(transport.attempts).toHaveLength(2);
    expect(transport.attempts[1]).toEqual(transport.attempts[0]);
    expect(transport.attempts[1]!.subject).toContain("Studio Mila Lashes");
    expect(transport.sent).toHaveLength(1);
    expect(await emailRow(confirmation!.id)).toMatchObject({
      status: "sent",
      provider_message_id: "memory-1",
      // Final: the frozen message is not kept.
      frozen: false,
    });
  });

  it("a worker crash after the provider call: the next claim resends the frozen message under the same key", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(31), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport({ idempotency: true });
    // Crash: claimed and prepared (message frozen), sent, never recorded.
    const [item] = await claimNow(business.id);
    expect(item!.message).toBeNull();
    const frozen = {
      to: confirmation!.recipient_email,
      from: FROM,
      subject: "Rendez-vous confirmé – Studio Mila Lashes",
      text: "texte figé",
      html: "<p>texte figé</p>",
    };
    const { data: prepared } = await bookingClient().rpc(
      "email_outbox_prepare",
      {
        p_id: item!.id,
        p_claim_id: item!.claimId,
        p_appointment_version: item!.appointment.version,
        p_message: frozen,
      },
    );
    expect(prepared).toEqual({ action: "send", message: frozen });
    await transport.send(
      { ...frozen, idempotencyKey: item!.id },
      AbortSignal.timeout(1000),
    );
    await expireLease(item!.id);

    expect(await worker(transport, business.id)).toMatchObject({ sent: 1 });
    expect(transport.attempts[1]).toEqual(transport.attempts[0]);
    expect(transport.sent).toHaveLength(1);
    expect((await attemptsOf(item!.id)).map((a) => a.outcome)).toEqual([
      "lease_expired",
      "sent",
    ]);
  });

  it("409 invalid_idempotent_request: the delivery stays unconfirmed, never resent nor reported unsent", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(32), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport();
    transport.failNext("provider_idempotency_conflict", "unconfirmed");
    expect(await worker(transport, business.id)).toMatchObject({
      unconfirmed: 1,
      retried: 0,
    });
    const row = await emailRow(confirmation!.id);
    expect(row).toMatchObject({
      status: "failed",
      last_error: "delivery_unconfirmed",
    });
    expect(row.first_submitted_at).not.toBeNull();
    expect(await attemptsOf(confirmation!.id)).toEqual([
      {
        attempt_number: 1,
        outcome: "unconfirmed",
        error_code: "provider_idempotency_conflict",
        provider_message_id: null,
      },
    ]);
    // Never claimed again (no new key, no resend).
    await retryNow(confirmation!.id);
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    expect(transport.attempts).toHaveLength(1);

    // She may have it: a cancellation is notified.
    await setStatus(business.id, booking.appointmentId, "cancelled");
    expect(
      (await emailOf(booking.appointmentId, "appointment_cancelled")).map(
        (e) => e.status,
      ),
    ).toEqual(["pending"]);
  });

  it("past the provider's idempotency window, an unanswered message is not resent", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(33), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport();
    transport.hangNext();
    expect(
      await worker(transport, business.id, { sendTimeoutMs: 200 }),
    ).toMatchObject({ retried: 1 });
    // The retries were held back (e.g. the daily cap) for a day.
    await db.query(
      `update public.email_events
       set first_submitted_at = now() - interval '24 hours',
           created_at = now() - interval '1 hour',
           next_attempt_at = now() - interval '1 second'
       where id = $1`,
      [confirmation!.id],
    );
    expect(await worker(transport, business.id)).toMatchObject({
      unconfirmed: 1,
    });
    expect(transport.attempts).toHaveLength(1);
    expect(await emailRow(confirmation!.id)).toMatchObject({
      status: "failed",
      last_error: "delivery_unconfirmed",
    });
    expect(
      (await attemptsOf(confirmation!.id)).map((a) => [
        a.outcome,
        a.error_code,
      ]),
    ).toEqual([
      ["retry", "provider_timeout"],
      ["unconfirmed", "idempotency_window_elapsed"],
    ]);
  });

  it("an appointment moved after a lost answer: the frozen details are never resent, the change notice gives the new ones", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(34), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport({ idempotency: true });
    transport.acceptThenFailNext("provider_timeout");
    await worker(transport, business.id);
    expect(transport.sent[0]!.text).toContain("à 10 h");

    await moveAppointment(
      business.id,
      booking.appointmentId,
      local(business, dateInDays(34), "15:30"),
    );
    // She may have the former details: a change notice is queued.
    expect(
      (await emailOf(booking.appointmentId, "appointment_changed")).map(
        (e) => e.status,
      ),
    ).toEqual(["pending"]);

    await retryNow(confirmation!.id);
    await worker(transport, business.id);
    expect(await emailRow(confirmation!.id)).toMatchObject({
      status: "cancelled",
      last_error: "superseded",
    });
    expect(transport.sent.map((m) => m.subject)).toEqual([
      "Rendez-vous confirmé – Studio Mila Lashes",
      "Rendez-vous modifié – Studio Mila Lashes",
    ]);
    expect(transport.sent[1]!.text).toContain("à 15 h 30");
  });

  it("an appointment changed (invisibly) between the claim and the provider call: rendered again, not counted as an attempt", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(35), "10:00"),
    );
    const [item] = await claimNow(business.id);
    // A change the customer does not see (an internal note): same email,
    // new appointment version.
    const { rows: current } = await db.query<{
      version: number;
      client_id: string;
    }>("select version, client_id from public.appointments where id = $1", [
      booking.appointmentId,
    ]);
    const { error: noteError } = await owner.client.rpc(
      "agenda_update_appointment",
      {
        p_business_id: business.id,
        p_appointment_id: booking.appointmentId,
        p_expected_version: current[0]!.version,
        p_service_id: service,
        p_client_id: current[0]!.client_id,
        p_internal_notes: "Allergie latex",
      },
    );
    expect(noteError).toBeNull();
    const { data: prepared } = await bookingClient().rpc(
      "email_outbox_prepare",
      {
        p_id: item!.id,
        p_claim_id: item!.claimId,
        p_appointment_version: item!.appointment.version,
        p_message: { to: "x", subject: "old", text: "old", html: "old" },
      },
    );
    expect(prepared).toEqual({ action: "rerender" });
    expect(await emailRow(item!.id)).toMatchObject({
      status: "pending",
      attempt_count: 0,
      frozen: false,
      first_submitted_at: null,
    });
    expect(await attemptsOf(item!.id)).toEqual([]);

    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.subject).toContain("Rendez-vous confirmé");
    expect(transport.sent[0]!.text).not.toContain("Allergie");
  });
});

describe("rendering failures", () => {
  it("a template error gives the email up at once, without retries nor customer data in logs", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(36), "10:00"),
      "render@example.test",
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const lines: string[] = [];
    for (const method of ["info", "warn", "error", "log"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const transport = new MemoryTransport();
    const result = await runEmailOutbox(
      {
        admin: bookingClient(),
        transport,
        from: FROM,
        appUrl: APP_URL,
        render: () => {
          throw new RangeError("Invalid currency for render@example.test");
        },
      },
      { businessId: business.id },
    );
    expect(result).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(transport.attempts).toEqual([]);
    expect(await emailRow(confirmation!.id)).toMatchObject({
      status: "failed",
      last_error: "render_failed",
      attempt_count: 1,
      first_submitted_at: null,
    });
    // Not claimed again: no attempts wasted on a deterministic error.
    await retryNow(confirmation!.id);
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });
    expect(lines.join("\n")).not.toContain("render@example.test");
  });
});

describe("rendering failures after a submission", () => {
  it("a retry sends the frozen message without rendering again (a template error now cannot block it)", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(40), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport({ idempotency: true });
    transport.acceptThenFailNext("provider_timeout");
    await worker(transport, business.id);
    await retryNow(confirmation!.id);
    let rendered = 0;
    const result = await runEmailOutbox(
      {
        admin: bookingClient(),
        transport,
        from: FROM,
        appUrl: APP_URL,
        render: () => {
          rendered += 1;
          throw new RangeError("template broken since");
        },
      },
      { businessId: business.id },
    );
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(rendered).toBe(0);
    expect(transport.attempts[1]).toEqual(transport.attempts[0]);
  });
});

describe("cancellation notices", () => {
  it("a public booking cancelled while its confirmation is still queued: the customer is told, the confirmation never goes", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(37), "10:00"),
      "screen@example.test",
    );
    // Confirmed on screen; the confirmation email is still pending.
    expect(booking.status).toBe("confirmed");
    await setStatus(business.id, booking.appointmentId, "cancelled");
    const rows = await emailsOf(booking.appointmentId);
    expect(rows.map((r) => [r.type, r.status, r.last_error])).toEqual([
      ["appointment_reminder", "cancelled", "appointment_cancelled"],
      ["booking_confirmation", "cancelled", "appointment_cancelled"],
      ["appointment_cancelled", "pending", null],
    ]);

    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(1);
    const notice = transport.sent[0]!;
    expect(notice.to).toBe("screen@example.test");
    expect(notice.subject).toBe("Rendez-vous annulé – Studio Mila Lashes");
    // Understandable without the confirmation she never received.
    expect(notice.text).toContain(
      "Votre rendez-vous a été annulé par l’établissement.",
    );
    expect(notice.text).toContain("Établissement : Studio Mila Lashes");
    expect(notice.text).toContain("Prestation : Volume mixte");
    expect(notice.text).toMatch(/Date : \w+ \d{1,2} \w+ \d{4} à 10 h/u);
    expect(notice.text).toContain(`${APP_URL}/b/${business.slug}`);

    // Nothing more, however many runs.
    await worker(transport, business.id);
    await worker(transport, business.id);
    expect(transport.attempts).toHaveLength(1);
  });

  it("a confirmation handed to the provider whose answer was lost: the cancellation is notified", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(38), "10:00"),
    );
    const transport = new MemoryTransport({ idempotency: true });
    transport.acceptThenFailNext("provider_network");
    await worker(transport, business.id);
    await setStatus(business.id, booking.appointmentId, "cancelled");
    await worker(transport, business.id);
    expect(transport.sent.map((m) => m.subject)).toEqual([
      "Rendez-vous confirmé – Studio Mila Lashes",
      "Rendez-vous annulé – Studio Mila Lashes",
    ]);
  });

  it("an appointment entered by the professional and never emailed: cancelled without notice; once reminded, notified", async () => {
    const { business, service } = await setup();
    const clientId = await createClientRecord(
      business.id,
      "manual@example.test",
    );
    const silent = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2027-09-10T08:00:00Z",
      endsAt: "2027-09-10T09:30:00Z",
    });
    await setStatus(business.id, silent, "cancelled");
    expect(await emailOf(silent, "appointment_cancelled")).toEqual([]);

    const reminded = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt: "2027-09-11T08:00:00Z",
      endsAt: "2027-09-11T09:30:00Z",
    });
    const [reminder] = await emailOf(reminded, "appointment_reminder");
    await makeDue(reminder!.id);
    await worker(new MemoryTransport(), business.id);
    await setStatus(business.id, reminded, "cancelled");
    expect(
      (await emailOf(reminded, "appointment_cancelled")).map((e) => e.status),
    ).toEqual(["pending"]);
  });

  it("a cancelled appointment never becomes confirmed again: one cancellation per appointment", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(39), "10:00"),
    );
    await setStatus(business.id, booking.appointmentId, "cancelled");
    await expect(
      setStatus(business.id, booking.appointmentId, "confirmed"),
    ).rejects.toMatchObject({ message: "invalid_status_transition" });
    // Members cannot write appointments directly either.
    const { data, error } = await owner.client
      .from("appointments")
      .update({ status: "confirmed" })
      .eq("id", booking.appointmentId)
      .select();
    expect(error !== null || (data ?? []).length === 0).toBe(true);
    const { rows } = await db.query<{ status: string }>(
      "select status::text from public.appointments where id = $1",
      [booking.appointmentId],
    );
    expect(rows[0]!.status).toBe("cancelled");
  });
});

describe("daily cap under concurrency", () => {
  it("concurrent claims never take more than the business's remaining attempts; other businesses are not held", async () => {
    const capped = await setup();
    const other = await setup();
    const clientA = await createClientRecord(
      capped.business.id,
      "capped@example.test",
    );
    const clientB = await createClientRecord(
      other.business.id,
      "other@example.test",
    );
    const due = async (
      business: TestBusiness,
      service: string,
      clientId: string,
      count: number,
    ) => {
      for (let i = 0; i < count; i++) {
        await insertAppointment({
          businessId: business.id,
          clientId,
          serviceId: service,
          startsAt: new Date(Date.UTC(2027, 10, 1 + i, 8)).toISOString(),
          endsAt: new Date(Date.UTC(2027, 10, 1 + i, 9, 30)).toISOString(),
        });
      }
      await db.query(
        `update public.email_events set scheduled_for = now() - interval '1 minute'
         where business_id = $1 and type = 'appointment_reminder'`,
        [business.id],
      );
    };
    await due(capped.business, capped.service, clientA, 20);
    await due(other.business, other.service, clientB, 6);
    // 295 attempts already today: 5 left.
    const { rows: anyEmail } = await db.query<{ id: string }>(
      "select id from public.email_events where business_id = $1 limit 1",
      [capped.business.id],
    );
    await db.query(
      `insert into public.email_delivery_attempts
         (business_id, email_event_id, attempt_number, claim_id, started_at, outcome)
       select $1, $2, n, gen_random_uuid(), now() - interval '1 hour', 'sent'
       from generate_series(1, 295) n`,
      [capped.business.id, anyEmail[0]!.id],
    );

    const claim = (businessId: string) =>
      bookingClient().rpc("email_outbox_claim", {
        p_business_id: businessId,
        p_limit: 20,
        p_per_business: 20,
      });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => claim(capped.business.id)),
      ...Array.from({ length: 3 }, () => claim(other.business.id)),
    ]);
    const count = (from: number, to: number) =>
      results.slice(from, to).reduce((sum, { data, error }) => {
        expect(error).toBeNull();
        return sum + (data as unknown[]).length;
      }, 0);
    expect(count(0, 10)).toBe(5);
    expect(count(10, 13)).toBe(6);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.email_delivery_attempts
       where business_id = $1 and started_at > now() - interval '24 hours'`,
      [capped.business.id],
    );
    expect(rows[0]!.n).toBe(300);
    const { rows: waiting } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.email_events
       where business_id = $1 and type = 'appointment_reminder' and status = 'pending'`,
      [capped.business.id],
    );
    expect(waiting[0]!.n).toBe(15);
  });
});

describe("public bookings: confirmed on screen", () => {
  it("a confirmation claimed when the booking is cancelled or moved is never sent", async () => {
    const { business, service } = await setup();
    const cancelled = await book(
      business,
      service,
      local(business, dateInDays(41), "10:00"),
    );
    const moved = await book(
      business,
      service,
      local(business, dateInDays(42), "10:00"),
    );
    // Both confirmations are claimed by a worker, not yet sent.
    const claimed = await claimNow(business.id);
    expect(claimed).toHaveLength(2);
    await setStatus(business.id, cancelled.appointmentId, "cancelled");
    await moveAppointment(
      business.id,
      moved.appointmentId,
      local(business, dateInDays(42), "14:00"),
    );
    for (const item of claimed) await expireLease(item.id);

    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent.map((m) => m.subject).sort()).toEqual([
      "Rendez-vous annulé – Studio Mila Lashes",
      "Rendez-vous modifié – Studio Mila Lashes",
    ]);
    expect(
      transport.sent.find((m) => m.subject.startsWith("Rendez-vous modifié"))!
        .text,
    ).toContain("à 14 h");
    const [first] = await emailOf(
      cancelled.appointmentId,
      "booking_confirmation",
    );
    const [second] = await emailOf(moved.appointmentId, "booking_confirmation");
    expect([first!.status, first!.last_error]).toEqual([
      "cancelled",
      "appointment_cancelled",
    ]);
    expect([second!.status, second!.last_error]).toEqual([
      "cancelled",
      "superseded",
    ]);
  });

  it("a confirmation already handed to the provider, then cancelled: one cancellation, no duplicate", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(43), "10:00"),
    );
    const transport = new MemoryTransport({ idempotency: true });
    await worker(transport, business.id);
    await setStatus(business.id, booking.appointmentId, "cancelled");
    for (let i = 0; i < 3; i++) await worker(transport, business.id);
    expect(transport.sent.map((m) => m.subject)).toEqual([
      "Rendez-vous confirmé – Studio Mila Lashes",
      "Rendez-vous annulé – Studio Mila Lashes",
    ]);
    expect(
      await emailOf(booking.appointmentId, "appointment_cancelled"),
    ).toHaveLength(1);
  });

  it("a cancellation notice whose answer was lost is retried identically and delivered once", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(44), "10:00"),
    );
    await setStatus(business.id, booking.appointmentId, "cancelled");
    const [notice] = await emailOf(
      booking.appointmentId,
      "appointment_cancelled",
    );
    const transport = new MemoryTransport({ idempotency: true });
    transport.acceptThenFailNext("provider_network");
    expect(await worker(transport, business.id)).toMatchObject({ retried: 1 });
    await retryNow(notice!.id);
    expect(await worker(transport, business.id)).toMatchObject({ sent: 1 });
    expect(transport.attempts).toHaveLength(2);
    expect(transport.attempts[1]).toEqual(transport.attempts[0]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.subject).toBe(
      "Rendez-vous annulé – Studio Mila Lashes",
    );
  });

  it("an appointment reassigned to another customer: the new contact, who booked nothing, is not told", async () => {
    const { business, service } = await setup();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(45), "10:00"),
      "booker@example.test",
    );
    const other = await createClientRecord(
      business.id,
      "other-contact@example.test",
    );
    await moveAppointment(
      business.id,
      booking.appointmentId,
      local(business, dateInDays(45), "10:00"),
      other,
    );
    await setStatus(business.id, booking.appointmentId, "cancelled");
    expect(
      await emailOf(booking.appointmentId, "appointment_cancelled"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Corrections after the Codex audit of PR #22
// ---------------------------------------------------------------------------

async function claimAt(at: string, businessId: string) {
  const { rows } = await db.query<{
    items: { id: string; type: string; claimId: string }[];
  }>("select private.email_outbox_claim_at($1, 20, 20, 120, $2) as items", [
    at,
    businessId,
  ]);
  return rows[0]!.items;
}

async function setTimezone(businessId: string, timezone: string) {
  const { error } = await owner.client
    .from("businesses")
    .update({ timezone })
    .eq("id", businessId);
  if (error) throw error;
}

describe("reminders follow a change of the business's time zone", () => {
  async function reminderSetup(timezone: string, startsAt: string) {
    const { business, service } = await setup({ timezone });
    const clientId = await createClientRecord(
      business.id,
      `tz-${randomUUID().slice(0, 6)}@example.test`,
    );
    const appointmentId = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId: service,
      startsAt,
      endsAt: new Date(
        new Date(startsAt).getTime() + 90 * 60_000,
      ).toISOString(),
    });
    const [reminder] = await emailOf(appointmentId, "appointment_reminder");
    return { business, appointmentId, reminder: reminder! };
  }

  it("Paris → Tokyo: the reminder moves earlier and is claimed at its new time", async () => {
    const { business, reminder } = await reminderSetup(
      "Europe/Paris",
      "2027-06-10T08:00:00Z",
    );
    expect(reminder.scheduled_for.toISOString()).toBe(
      "2027-06-09T16:00:00.000Z",
    );

    await setTimezone(business.id, "Asia/Tokyo");
    // 10 June 08:00 UTC is 17:00 in Tokyo: the reminder is 9 June, 18:00
    // in Tokyo, 09:00 UTC.
    const { rows } = await db.query<{ scheduled_for: Date; status: string }>(
      "select scheduled_for, status::text from public.email_events where id = $1",
      [reminder.id],
    );
    expect(rows[0]).toMatchObject({ status: "pending" });
    expect(rows[0]!.scheduled_for.toISOString()).toBe(
      "2027-06-09T09:00:00.000Z",
    );

    // 10:00 UTC: due under the new zone (the old moment, 16:00, is ahead).
    const items = await claimAt("2027-06-09T10:00:00Z", business.id);
    expect(items.map((item) => item.id)).toEqual([reminder.id]);
  });

  it("Tokyo → Paris: the reminder moves later and is not claimed at its former time", async () => {
    const { business, reminder } = await reminderSetup(
      "Asia/Tokyo",
      "2027-06-10T08:00:00Z",
    );
    expect(reminder.scheduled_for.toISOString()).toBe(
      "2027-06-09T09:00:00.000Z",
    );

    await setTimezone(business.id, "Europe/Paris");
    expect(await claimAt("2027-06-09T10:00:00Z", business.id)).toEqual([]);
    const { rows } = await db.query<{ scheduled_for: Date; status: string }>(
      "select scheduled_for, status::text from public.email_events where id = $1",
      [reminder.id],
    );
    expect(rows[0]).toMatchObject({ status: "pending" });
    expect(rows[0]!.scheduled_for.toISOString()).toBe(
      "2027-06-09T16:00:00.000Z",
    );
    expect(
      (await claimAt("2027-06-09T16:00:00Z", business.id)).map((i) => i.id),
    ).toEqual([reminder.id]);
  });

  it("across a clock change: London → New York, the reminder day being the end of DST", async () => {
    // Monday 8 November 2027; New York leaves DST on Sunday 7 November.
    const { business, reminder } = await reminderSetup(
      "Europe/London",
      "2027-11-08T14:00:00Z",
    );
    expect(reminder.scheduled_for.toISOString()).toBe(
      "2027-11-07T18:00:00.000Z",
    );
    await setTimezone(business.id, "America/New_York");
    // 7 November 18:00 EST (UTC−5) = 23:00 UTC.
    expect(await claimAt("2027-11-07T22:30:00Z", business.id)).toEqual([]);
    expect(
      (await claimAt("2027-11-07T23:00:00Z", business.id)).map((i) => i.id),
    ).toEqual([reminder.id]);
  });

  it("a reminder whose new moment is already past is delivered by the worker now", async () => {
    // Find an appointment start whose reminder is ahead in Los Angeles but
    // already past at UTC+14 (Kiritimati): a day earlier.
    const { rows: pick } = await db.query<{ starts_at: Date }>(
      `select s as starts_at
       from generate_series(
              date_trunc('hour', now()) + interval '20 hours',
              date_trunc('hour', now()) + interval '72 hours',
              interval '1 hour') s
       where private.email_reminder_at(s, 'America/Los_Angeles') > now() + interval '1 hour'
         and private.email_reminder_at(s, 'Pacific/Kiritimati') < now()
         and s - interval '2 hours' > now()
       limit 1`,
    );
    expect(pick).toHaveLength(1);
    const { business, reminder } = await reminderSetup(
      "America/Los_Angeles",
      pick[0]!.starts_at.toISOString(),
    );
    const transport = new MemoryTransport();
    expect(await worker(transport, business.id)).toMatchObject({ claimed: 0 });

    await setTimezone(business.id, "Pacific/Kiritimati");
    expect(await worker(transport, business.id)).toMatchObject({ sent: 1 });
    expect(transport.sent[0]!.idempotencyKey).toBe(reminder.id);
    expect(transport.sent[0]!.subject).toContain("Rappel");
  });

  it("a reminder already claimed when the zone moves it later is not sent early", async () => {
    const { business, reminder } = await reminderSetup(
      "Asia/Tokyo",
      "2027-06-10T08:00:00Z",
    );
    const [item] = await claimAt("2027-06-09T09:30:00Z", business.id);
    expect(item!.id).toBe(reminder.id);
    await setTimezone(business.id, "Europe/Paris");
    const { rows: claim } = await db.query<{
      claim_id: string;
      version: number;
    }>(
      `select e.claim_id, a.version from public.email_events e
       join public.appointments a on a.id = e.appointment_id where e.id = $1`,
      [reminder.id],
    );
    const { data: prepared } = await bookingClient().rpc(
      "email_outbox_prepare",
      {
        p_id: reminder.id,
        p_claim_id: claim[0]!.claim_id,
        p_appointment_version: claim[0]!.version,
        p_message: { to: "x", subject: "s", text: "t", html: "h" },
      },
    );
    expect(prepared).toEqual({ action: "rerender" });
    const { rows } = await db.query<{
      scheduled_for: Date;
      status: string;
      attempt_count: number;
    }>(
      "select scheduled_for, status::text, attempt_count from public.email_events where id = $1",
      [reminder.id],
    );
    expect(rows[0]).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(rows[0]!.scheduled_for.toISOString()).toBe(
      "2027-06-09T16:00:00.000Z",
    );
  });

  // A reminder claimed at `claimedAt` whose send failed temporarily: the
  // retry is due at `retryAt` (email_outbox_fail runs on the real clock;
  // its backoff is placed relative to the simulated claim).
  async function failedReminder(
    timezone: string,
    startsAt: string,
    claimedAt: string,
    retryAt: string,
  ) {
    const setupResult = await reminderSetup(timezone, startsAt);
    const [item] = await claimAt(claimedAt, setupResult.business.id);
    expect(item!.id).toBe(setupResult.reminder.id);
    const { data: status, error } = await bookingClient().rpc(
      "email_outbox_fail",
      {
        p_id: item!.id,
        p_claim_id: item!.claimId,
        p_error_code: "provider_unavailable",
      },
    );
    expect(error).toBeNull();
    expect(status).toBe("pending");
    await db.query(
      "update public.email_events set next_attempt_at = $2 where id = $1",
      [item!.id, retryAt],
    );
    return setupResult;
  }

  it("a reminder in retry is not sent before the later deadline of the new zone (Tokyo → Paris)", async () => {
    // Due at 09:00 UTC in Tokyo; the retry is due at 09:01 UTC.
    const { business, appointmentId, reminder } = await failedReminder(
      "Asia/Tokyo",
      "2027-06-10T08:00:00Z",
      "2027-06-09T09:00:00Z",
      "2027-06-09T09:01:00Z",
    );
    await setTimezone(business.id, "Europe/Paris");

    // The backoff is over, the reminder deadline (16:00 UTC) is not.
    expect(await claimAt("2027-06-09T09:05:00Z", business.id)).toEqual([]);
    expect(await claimAt("2027-06-09T15:59:00Z", business.id)).toEqual([]);

    // At the deadline, concurrent workers: one claim, one attempt.
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        claimAt("2027-06-09T16:00:00Z", business.id),
      ),
    );
    expect(claims.flat().map((item) => item.id)).toEqual([reminder.id]);
    const { rows } = await db.query<{ status: string; attempt_count: number }>(
      "select status::text, attempt_count from public.email_events where id = $1",
      [reminder.id],
    );
    expect(rows[0]).toEqual({ status: "processing", attempt_count: 2 });
    expect(
      (await attemptsOf(reminder.id)).map((attempt) => attempt.outcome),
    ).toEqual(["retry", null]);
    expect(await emailOf(appointmentId, "appointment_reminder")).toHaveLength(
      1,
    );
  });

  it("a reminder in retry keeps its backoff when the new zone's deadline is already past (New York → London, end of DST)", async () => {
    // 7 November 2027, 18:00 EST = 23:00 UTC; in London, 18:00 UTC.
    const { business, reminder } = await failedReminder(
      "America/New_York",
      "2027-11-08T14:00:00Z",
      "2027-11-07T23:00:00Z",
      "2027-11-07T23:10:00Z",
    );
    await setTimezone(business.id, "Europe/London");
    const { rows } = await db.query<{ scheduled_for: Date }>(
      "select scheduled_for from public.email_events where id = $1",
      [reminder.id],
    );
    expect(rows[0]!.scheduled_for.toISOString()).toBe(
      "2027-11-07T18:00:00.000Z",
    );

    // The reminder deadline is past, the backoff is not.
    expect(await claimAt("2027-11-07T23:05:00Z", business.id)).toEqual([]);
    expect(
      (await claimAt("2027-11-07T23:10:00Z", business.id)).map((i) => i.id),
    ).toEqual([reminder.id]);
  });

  it("other emails in retry keep their own schedule when the zone changes", async () => {
    const { business, service } = await setup({ timezone: "Asia/Tokyo" });
    const booking = await book(
      business,
      service,
      local(business, dateInDays(3), "10:00"),
    );
    const transport = new MemoryTransport();
    transport.failNext("provider_unavailable");
    expect(await worker(transport, business.id)).toMatchObject({
      retried: 1,
    });
    const [before] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    await setTimezone(business.id, "Europe/Paris");
    const [after] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    expect(after).toMatchObject({
      status: "pending",
      scheduled_for: before!.scheduled_for,
      next_attempt_at: before!.next_attempt_at,
    });
    // Due when its backoff ends, as before (JavaScript dates drop the
    // microseconds: a second later).
    const retryAt = before!.next_attempt_at!.getTime();
    expect(
      await claimAt(new Date(retryAt - 5_000).toISOString(), business.id),
    ).toEqual([]);
    expect(
      await claimAt(new Date(retryAt + 1_000).toISOString(), business.id),
    ).toMatchObject([{ id: before!.id }]);
  });

  it("cancelled reminders stay cancelled and no reminder is duplicated", async () => {
    const { business, appointmentId, reminder } = await reminderSetup(
      "Europe/Paris",
      "2027-06-12T08:00:00Z",
    );
    const other = await reminderSetup("Europe/Paris", "2027-06-13T08:00:00Z");
    await setStatus(business.id, appointmentId, "cancelled");
    await setTimezone(business.id, "Asia/Tokyo");
    const { rows } = await db.query<{ status: string; n: number }>(
      `select status::text, count(*)::int as n from public.email_events
       where appointment_id = $1 and type = 'appointment_reminder' group by status`,
      [appointmentId],
    );
    expect(rows).toEqual([{ status: "cancelled", n: 1 }]);
    expect(reminder.status).toBe("pending");
    // Another business is not touched.
    const [untouched] = await emailOf(
      other.appointmentId,
      "appointment_reminder",
    );
    expect(untouched!.scheduled_for.toISOString()).toBe(
      "2027-06-12T16:00:00.000Z",
    );
  });
});

describe("customer-visible price changes", () => {
  async function priced() {
    const { business, service } = await setup();
    const sameName = await createService(business.id, {
      name: "Volume mixte",
      durationMinutes: 90,
      priceCents: 8000,
    });
    const identical = await createService(business.id, {
      name: "Volume mixte",
      durationMinutes: 90,
      priceCents: 8500,
    });
    return { business, service, sameName, identical };
  }

  async function changeService(
    businessId: string,
    appointmentId: string,
    serviceId: string,
  ) {
    const { rows } = await db.query<{ version: number; client_id: string }>(
      "select version, client_id from public.appointments where id = $1",
      [appointmentId],
    );
    const { error } = await owner.client.rpc("agenda_update_appointment", {
      p_business_id: businessId,
      p_appointment_id: appointmentId,
      p_expected_version: rows[0]!.version,
      p_service_id: serviceId,
      p_client_id: rows[0]!.client_id,
    });
    if (error) throw error;
  }

  it("a service of the same name and duration but another price: a change notice with the new price", async () => {
    const { business, service, sameName } = await priced();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(46), "10:00"),
    );
    const transport = new MemoryTransport();
    await worker(transport, business.id);
    expect(transport.sent[0]!.text).toMatch(/Prix : 85,00\s€/u);

    await changeService(business.id, booking.appointmentId, sameName);
    const changes = await emailOf(booking.appointmentId, "appointment_changed");
    expect(changes.map((c) => c.status)).toEqual(["pending"]);
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.subject).toBe(
      "Rendez-vous modifié – Studio Mila Lashes",
    );
    expect(transport.sent[1]!.text).toMatch(/Prix : 80,00\s€/u);
  });

  it("a currency change of the appointment is notified", async () => {
    const { business, service, sameName } = await priced();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(47), "10:00"),
    );
    const transport = new MemoryTransport();
    await worker(transport, business.id);
    await db.query(
      "update public.business_settings set currency = 'CHF' where business_id = $1",
      [business.id],
    );
    await changeService(business.id, booking.appointmentId, sameName);
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.text).toMatch(/Prix : 80,00\sCHF/u);
  });

  it("after a lost answer, a price change never re-submits the old key with another payload; a corrective notice goes", async () => {
    const { business, service, sameName } = await priced();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(48), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport({ idempotency: true });
    transport.acceptThenFailNext("provider_timeout");
    await worker(transport, business.id);
    // The customer may hold the 85 € message.
    expect(transport.sent[0]!.text).toMatch(/Prix : 85,00\s€/u);

    await changeService(business.id, booking.appointmentId, sameName);
    await retryNow(confirmation!.id);
    await worker(transport, business.id);

    // The confirmation's key only ever carried its one payload.
    const sentUnderKey = transport.attempts.filter(
      (m) => m.idempotencyKey === confirmation!.id,
    );
    expect(sentUnderKey).toHaveLength(1);
    expect(await emailRow(confirmation!.id)).toMatchObject({
      status: "cancelled",
      last_error: "superseded",
    });
    expect(transport.sent.map((m) => m.subject)).toEqual([
      "Rendez-vous confirmé – Studio Mila Lashes",
      "Rendez-vous modifié – Studio Mila Lashes",
    ]);
    expect(transport.sent[1]!.text).toMatch(/Prix : 80,00\s€/u);
    expect(transport.sent[1]!.idempotencyKey).not.toBe(confirmation!.id);
  });

  it("a reminder handed to the provider with the former price is never resent; the change notice gives the new one", async () => {
    const { business, service, sameName } = await priced();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(51), "10:00"),
    );
    const transport = new MemoryTransport({ idempotency: true });
    await worker(transport, business.id); // the confirmation (85 €)
    const [reminder] = await emailOf(
      booking.appointmentId,
      "appointment_reminder",
    );
    await makeDue(reminder!.id);
    transport.acceptThenFailNext("provider_timeout");
    await worker(transport, business.id); // reminder frozen at 85 €, answer lost
    expect(await emailRow(reminder!.id)).toMatchObject({
      status: "pending",
      frozen: true,
    });

    await changeService(business.id, booking.appointmentId, sameName);
    await retryNow(reminder!.id);
    // The worker claims it (as a lost answer may well be retried), but the
    // frozen 85 € message no longer matches the appointment.
    await worker(transport, business.id);
    expect(await emailRow(reminder!.id)).toMatchObject({
      status: "cancelled",
      last_error: "superseded",
    });
    expect(
      transport.attempts.filter((m) => m.idempotencyKey === reminder!.id),
    ).toHaveLength(1);
    const notices = transport.sent.filter((m) =>
      m.subject.startsWith("Rendez-vous modifié"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toMatch(/Prix : 80,00\s€/u);
  });

  it("a price change of the catalogue only keeps the booked price; nothing is sent again", async () => {
    const { business, service } = await priced();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(49), "10:00"),
    );
    const [confirmation] = await emailOf(
      booking.appointmentId,
      "booking_confirmation",
    );
    const transport = new MemoryTransport({ idempotency: true });
    transport.acceptThenFailNext("provider_timeout");
    await worker(transport, business.id);

    await db.query(
      "update public.services set price_cents = 9900 where id = $1",
      [service],
    );
    await retryNow(confirmation!.id);
    await worker(transport, business.id);
    expect(transport.attempts[1]).toEqual(transport.attempts[0]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toMatch(/Prix : 85,00\s€/u);
    expect(await emailOf(booking.appointmentId, "appointment_changed")).toEqual(
      [],
    );
    const { rows } = await db.query<{ price_cents_snapshot: number }>(
      "select price_cents_snapshot from public.appointments where id = $1",
      [booking.appointmentId],
    );
    expect(rows[0]!.price_cents_snapshot).toBe(8500);
  });

  it("another service identical for the customer (name, duration, price, currency): no email", async () => {
    const { business, service, identical } = await priced();
    const booking = await book(
      business,
      service,
      local(business, dateInDays(50), "10:00"),
    );
    const transport = new MemoryTransport();
    await worker(transport, business.id);
    await changeService(business.id, booking.appointmentId, identical);
    expect(await emailOf(booking.appointmentId, "appointment_changed")).toEqual(
      [],
    );
    await worker(transport, business.id);
    expect(transport.sent).toHaveLength(1);
  });
});
