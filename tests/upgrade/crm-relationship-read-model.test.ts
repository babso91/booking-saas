import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade of a populated database from the customer identity
// (20261012090000) to the relationship read model (20261013090000): the
// migration only adds read functions and one index; existing records are
// read as they are, nothing is rewritten.

const BEFORE = "20261012090000";

let owner: Professional;
let businessId: string;
let clientId: string;
let visit: string;
let rowsBefore: string;

const inDays = (days: number, hour: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

async function tables() {
  const { rows } = await db.query(
    `select
       (select md5(string_agg(a::text, '|' order by a.id)) from public.appointments a where a.business_id = $1) as appointments,
       (select md5(string_agg(c::text, '|' order by c.id)) from public.clients c where c.business_id = $1) as clients,
       (select md5(string_agg(e::text, '|' order by e.id)) from public.email_events e where e.business_id = $1) as emails`,
    [businessId],
  );
  return JSON.stringify(rows[0]);
}

/** Runs `sql` as the business owner (authenticated, RLS on). */
async function asOwner<T>(sql: string, params: unknown[]): Promise<T[]> {
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query(
      "select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: owner.userId, role: "authenticated" })],
    );
    await connection.query("set local role authenticated");
    const { rows } = await connection.query(sql, params);
    return rows as T[];
  } finally {
    await connection.query("rollback");
    connection.release();
  }
}

beforeAll(async () => {
  resetTo(BEFORE);
  owner = await createProfessional("upgrade-crm-read");
  businessId = (await createBusiness(owner.userId, { timezone: "UTC" })).id;
  const service = await createService(businessId, {
    name: "Coupe",
    durationMinutes: 60,
    priceCents: 4000,
  });
  clientId = await createClientRecord(businessId, "lea@x.test", "Léa");
  visit = await insertAppointment({
    businessId,
    clientId,
    serviceId: service,
    startsAt: inDays(-7, 9),
    endsAt: inDays(-7, 10),
    status: "completed",
  });
  await insertAppointment({
    businessId,
    clientId,
    serviceId: service,
    startsAt: inDays(7, 9),
    endsAt: inDays(7, 10),
  });
  await db.query(
    `insert into public.email_events (business_id, client_id, appointment_id, type, recipient_email, dedupe_key)
     values ($1, $2, $3, 'booking_confirmation', 'lea@x.test', 'upgrade-crm-read')`,
    [businessId, clientId, visit],
  );
  // The customer's record changes after the visit: history keeps the
  // appointment's own contact.
  await db.query(
    "update public.clients set first_name = 'Léa-Marie' where id = $1",
    [clientId],
  );
  rowsBefore = await tables();

  migrateUp();
});

describe("upgrading to the relationship read model", () => {
  it("adds the customer email index and rewrites nothing", async () => {
    const { rows } = await db.query(
      "select indexdef from pg_indexes where indexname = 'email_events_client_timeline_idx'",
    );
    expect(rows[0]?.indexdef).toMatch(
      /\(business_id, client_id, created_at DESC, id\)/,
    );
    expect(await tables()).toBe(rowsBefore);
  });

  it("reads existing records: metrics, current record, appointment snapshot, scheduled email", async () => {
    const [profile] = await asOwner<{ profile: Record<string, never> }>(
      "select public.crm_client_profile($1, $2) as profile",
      [businessId, clientId],
    );
    expect(profile!.profile).toMatchObject({
      client: { firstName: "Léa-Marie", email: "lea@x.test" },
      activity: { completedCount: 1, upcomingCount: 1, pastConfirmedCount: 0 },
      completedValue: [
        { currency: "EUR", amountCents: 4000, appointmentCount: 1 },
      ],
    });

    const events = await asOwner<{
      event_id: string;
      data: Record<string, never>;
    }>("select event_id, data from public.crm_client_timeline($1, $2, 20)", [
      businessId,
      clientId,
    ]);
    expect(events.map((event) => event.event_id.split(":")[0]).sort()).toEqual([
      "appointment",
      "email",
    ]);
    const appointment = events.find(
      (event) => event.event_id === `appointment:${visit}`,
    );
    expect(appointment?.data).toMatchObject({
      status: "completed",
      contact: { firstName: "Léa", email: "lea@x.test" },
    });
    const email = events.find((event) => event.event_id.startsWith("email:"));
    expect(email?.data).toMatchObject({ status: "pending", sentAt: null });

    const [list] = await asOwner<{ page: Record<string, never> }>(
      "select public.crm_list_clients($1) as page",
      [businessId],
    );
    expect(list!.page).toMatchObject({
      totalCount: 1,
      rows: [{ id: clientId, completedCount: 1, upcomingCount: 1 }],
    });
    expect(await tables()).toBe(rowsBefore);
  });
});
