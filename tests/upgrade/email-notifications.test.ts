import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade from the public booking hardening (20261018090000) to the
// transactional emails (20261019090000), with a populated database: past,
// upcoming, cancelled appointments, a customer without email, and outbox
// rows written before (a pending confirmation, legacy rows with a free-text
// error and a "processing" row without claim, as an earlier tool could
// have left). Nothing existing is rewritten; upcoming confirmed
// appointments get their reminder; legacy rows stay readable and are
// handled by the worker's rules.

const BEFORE = "20261018090000";

let business: TestBusiness;
let upcoming: string;
let past: string;
let cancelled: string;
let withoutEmail: string;
let pendingConfirmation: string;
let legacyFailed: string;
let legacyProcessing: string;
let legacyBefore: string;
let appointmentsBefore: string;

const inDays = (days: number, hour: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};
const plus90 = (iso: string) =>
  new Date(new Date(iso).getTime() + 90 * 60_000).toISOString();

/** The rows written before the upgrade, every column they had then. */
async function legacyRows() {
  const { rows } = await db.query(
    `select md5(string_agg(
       (e.id, e.business_id, e.client_id, e.appointment_id, e.type, e.status,
        e.recipient_email, e.payload, e.dedupe_key, e.scheduled_for,
        e.attempt_count, e.last_attempt_at, e.sent_at, e.provider_message_id,
        e.last_error, e.created_at, e.updated_at)::text,
       '|' order by e.id)) as hash
     from public.email_events e where e.id = any($1)`,
    [[pendingConfirmation, legacyFailed, legacyProcessing]],
  );
  return rows[0].hash as string;
}

async function appointmentsHash() {
  const { rows } = await db.query(
    `select md5(string_agg(a::text, '|' order by a.id)) as hash
     from public.appointments a where a.business_id = $1`,
    [business.id],
  );
  return rows[0].hash as string;
}

async function insertEmail(
  appointmentId: string,
  key: string,
  fields: { status: string; lastError?: string | null },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.email_events
       (business_id, client_id, appointment_id, type, recipient_email, dedupe_key, status, last_error)
     select business_id, client_id, id, 'booking_confirmation', client_email_snapshot, $2, $3::public.email_event_status, $4
     from public.appointments where id = $1
     returning id`,
    [appointmentId, key, fields.status, fields.lastError ?? null],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  resetTo(BEFORE);
  const owner = await createProfessional("upgrade-emails");
  business = await createBusiness(owner.userId, { timezone: "Europe/Paris" });
  const service = await createService(business.id, { durationMinutes: 90 });
  const lea = await createClientRecord(business.id, "lea@example.test", "Léa");
  const { rows } = await db.query<{ id: string }>(
    `insert into public.clients (business_id, first_name, phone)
     values ($1, 'Sans email', '0600000000') returning id`,
    [business.id],
  );

  upcoming = await insertAppointment({
    businessId: business.id,
    clientId: lea,
    serviceId: service,
    startsAt: inDays(5, 8),
    endsAt: plus90(inDays(5, 8)),
  });
  past = await insertAppointment({
    businessId: business.id,
    clientId: lea,
    serviceId: service,
    startsAt: inDays(-5, 8),
    endsAt: plus90(inDays(-5, 8)),
    status: "completed",
  });
  cancelled = await insertAppointment({
    businessId: business.id,
    clientId: lea,
    serviceId: service,
    startsAt: inDays(6, 8),
    endsAt: plus90(inDays(6, 8)),
    status: "cancelled",
  });
  withoutEmail = await insertAppointment({
    businessId: business.id,
    clientId: rows[0]!.id,
    serviceId: service,
    startsAt: inDays(7, 8),
    endsAt: plus90(inDays(7, 8)),
  });
  pendingConfirmation = await insertEmail(
    upcoming,
    "booking_confirmation:legacy-upcoming",
    {
      status: "pending",
    },
  );
  legacyFailed = await insertEmail(past, "legacy-failed", {
    status: "failed",
    lastError: "SMTP 550: mailbox lea@example.test unavailable",
  });
  legacyProcessing = await insertEmail(cancelled, "legacy-processing", {
    status: "processing",
  });
  legacyBefore = await legacyRows();
  appointmentsBefore = await appointmentsHash();

  migrateUp();
});

describe("upgrading to the transactional emails", () => {
  it("rewrites no existing outbox row nor appointment", async () => {
    expect(await legacyRows()).toBe(legacyBefore);
    expect(await appointmentsHash()).toBe(appointmentsBefore);
    // A legacy free-text error is kept as it was (the new check applies to
    // new writes only).
    const { rows } = await db.query(
      "select status::text, last_error from public.email_events where id = $1",
      [legacyFailed],
    );
    expect(rows[0]).toEqual({
      status: "failed",
      last_error: "SMTP 550: mailbox lea@example.test unavailable",
    });
  });

  it("queues the reminder of each upcoming confirmed appointment with an email, and only those", async () => {
    const { rows } = await db.query<{
      appointment_id: string;
      scheduled_for: Date;
    }>(
      `select appointment_id, scheduled_for from public.email_events
       where business_id = $1 and type = 'appointment_reminder'`,
      [business.id],
    );
    expect(rows.map((row) => row.appointment_id)).toEqual([upcoming]);
    const { rows: expected } = await db.query<{ at: Date }>(
      `select private.email_reminder_at(starts_at, 'Europe/Paris') as at
       from public.appointments where id = $1`,
      [upcoming],
    );
    expect(rows[0]!.scheduled_for.toISOString()).toBe(
      expected[0]!.at.toISOString(),
    );
    for (const id of [past, cancelled, withoutEmail]) {
      const { rows: none } = await db.query(
        "select 1 from public.email_events where appointment_id = $1 and type = 'appointment_reminder'",
        [id],
      );
      expect(none).toEqual([]);
    }
  });

  it("the worker's rules apply to rows written before: obsolete ones are cancelled, nothing is lost", async () => {
    const { rows } = await db.query<{ items: { id: string }[] }>(
      "select private.email_outbox_claim_at(now(), 20, 20, 120, $1) as items",
      [business.id],
    );
    // The confirmation of the upcoming appointment is still deliverable.
    expect(rows[0]!.items.map((item) => item.id)).toEqual([
      pendingConfirmation,
    ]);
    const { rows: states } = await db.query(
      `select id, status::text, last_error from public.email_events
       where id = any($1) order by id`,
      [[legacyProcessing, legacyFailed]],
    );
    expect(
      Object.fromEntries(
        states.map((row) => [row.id, [row.status, row.last_error]]),
      ),
    ).toEqual({
      // Its appointment is cancelled: never sent.
      [legacyProcessing]: ["cancelled", "appointment_cancelled"],
      // Final states are never claimed again.
      [legacyFailed]: [
        "failed",
        "SMTP 550: mailbox lea@example.test unavailable",
      ],
    });
  });
});
