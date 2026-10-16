import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  setWeeklyHours,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade of a populated database from the setup write guarantees
// (20261016090000) to the public booking guarantees (20261017090000):
// existing appointments are untouched; the new booking function works on
// the existing schedule, and only the service role can call it.

const BEFORE = "20261016090000";

let business: TestBusiness;
let service: string;
let rowsBefore: string;

const inDays = (days: number, hour: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

async function appointments() {
  const { rows } = await db.query(
    `select md5(string_agg(a::text, '|' order by a.id)) as hash
     from public.appointments a where a.business_id = $1`,
    [business.id],
  );
  return rows[0].hash as string;
}

beforeAll(async () => {
  resetTo(BEFORE);
  const owner = await createProfessional("upgrade-public-booking");
  business = await createBusiness(owner.userId, {
    timezone: "UTC",
    settings: { minimum_booking_notice_minutes: 0 },
  });
  service = await createService(business.id, { durationMinutes: 60 });
  await setWeeklyHours(
    business.id,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => [weekday, "08:00", "18:00"]),
  );
  const client = await createClientRecord(business.id, "before@x.test");
  await insertAppointment({
    businessId: business.id,
    clientId: client,
    serviceId: service,
    startsAt: inDays(3, 9),
    endsAt: inDays(3, 10),
  });
  rowsBefore = await appointments();

  migrateUp();
});

describe("upgrading to the public booking guarantees", () => {
  it("leaves existing appointments untouched", async () => {
    expect(await appointments()).toBe(rowsBefore);
  });

  it("books once per request on the existing schedule, as the service role only", async () => {
    const requestId = randomUUID();
    const book = async (role: string) => {
      const connection = await db.connect();
      try {
        await connection.query("begin");
        await connection.query(`set local role ${role}`);
        const { rows } = await connection.query<{
          appointment_id: string;
          replayed: boolean;
        }>(
          `select appointment_id, replayed from public.create_public_booking(
             p_slug => $1, p_service_id => $2, p_starts_at => $3,
             p_first_name => 'Léa', p_email => 'after@x.test',
             p_request_id => $4, p_client_key => 'upgrade')`,
          [business.slug, service, inDays(4, 10), requestId],
        );
        await connection.query("commit");
        return rows[0]!;
      } catch (error) {
        await connection.query("rollback");
        throw error;
      } finally {
        connection.release();
      }
    };

    await expect(book("anon")).rejects.toMatchObject({ code: "42501" });
    const first = await book("service_role");
    expect(first.replayed).toBe(false);
    expect(await book("service_role")).toEqual({
      appointment_id: first.appointment_id,
      replayed: true,
    });
    const { rows } = await db.query(
      "select count(*)::int as count from public.appointments where business_id = $1",
      [business.id],
    );
    expect(rows[0]).toEqual({ count: 2 });
  });
});
