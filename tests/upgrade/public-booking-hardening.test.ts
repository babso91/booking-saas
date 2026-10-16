import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createProfessional,
  createService,
  db,
  setWeeklyHours,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade from the first public booking guarantees (20261017090000) to the
// hardening after the audits (20261018090000), with a populated database:
// bookings made with request ids, their customers, and log rows holding
// the old unsalted hashes. Appointments, idempotency and customers are kept;
// the old log rows are deleted (unsalted, so reversible for IPv4).

const BEFORE = "20261017090000";

let business: TestBusiness;
let service: string;
let requestId: string;
let appointment: string;
let rowsBefore: string;

const inDays = (days: number, hour: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

async function asServiceRole<T>(sql: string, params: unknown[]): Promise<T[]> {
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query("set local role service_role");
    const { rows } = await connection.query(sql, params);
    await connection.query("commit");
    return rows as T[];
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

async function snapshot() {
  const { rows } = await db.query(
    `select
       (select md5(string_agg(a::text, '|' order by a.id)) from public.appointments a where a.business_id = $1) as appointments,
       (select md5(string_agg(c::text, '|' order by c.id)) from public.clients c where c.business_id = $1) as clients`,
    [business.id],
  );
  return JSON.stringify(rows[0]);
}

beforeAll(async () => {
  resetTo(BEFORE);
  const owner = await createProfessional("upgrade-public-hardening");
  business = await createBusiness(owner.userId, {
    timezone: "UTC",
    settings: { minimum_booking_notice_minutes: 0 },
  });
  service = await createService(business.id, { durationMinutes: 60 });
  await setWeeklyHours(
    business.id,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => [weekday, "08:00", "18:00"]),
  );
  await db.query(
    "insert into public.clients (business_id, first_name, email) values ($1, 'Camille', 'camille@x.test')",
    [business.id],
  );
  requestId = randomUUID();
  const [booked] = await asServiceRole<{ appointment_id: string }>(
    `select appointment_id from public.create_public_booking(
       p_slug => $1, p_service_id => $2, p_starts_at => $3,
       p_first_name => 'Léa', p_email => 'lea@x.test',
       p_request_id => $4, p_client_key => '192.0.2.1')`,
    [business.slug, service, inDays(3, 9), requestId],
  );
  appointment = booked!.appointment_id;
  rowsBefore = await snapshot();

  migrateUp();
});

describe("upgrading to the public booking hardening", () => {
  it("keeps appointments and customers; deletes the unsalted log rows", async () => {
    expect(await snapshot()).toBe(rowsBefore);
    const { rows } = await db.query(
      "select count(*)::int as count from private.public_booking_log",
    );
    expect(rows[0]).toEqual({ count: 0 });
  });

  it("still answers a booking made before the upgrade from its request id", async () => {
    const [replayed] = await asServiceRole<{
      appointment_id: string;
      replayed: boolean;
    }>(
      `select appointment_id, replayed from public.create_public_booking(
         p_slug => $1, p_service_id => $2, p_starts_at => $3,
         p_first_name => 'Léa', p_email => 'lea@x.test',
         p_request_id => $4, p_client_ip => '192.0.2.1')`,
      [business.slug, service, inDays(3, 9), requestId],
    );
    expect(replayed).toEqual({ appointment_id: appointment, replayed: true });
  });

  it("links an existing customer without filling her empty fields", async () => {
    await asServiceRole(
      `select appointment_id from public.create_public_booking(
         p_slug => $1, p_service_id => $2, p_starts_at => $3,
         p_first_name => 'Intrus', p_email => 'CAMILLE@x.test',
         p_request_id => gen_random_uuid(), p_client_ip => '192.0.2.2',
         p_last_name => 'Usurpateur', p_phone => '0666666666')`,
      [business.slug, service, inDays(4, 9)],
    );
    const { rows } = await db.query(
      "select first_name, last_name, phone from public.clients where email = 'camille@x.test'",
    );
    expect(rows).toEqual([
      { first_name: "Camille", last_name: null, phone: null },
    ]);
  });
});
