import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createService,
  createProfessional,
  db,
  insertAppointment,
  setWeeklyHours,
  type Professional,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade of a populated database from notes in the relationship timeline
// (20261015090000) to the setup write guarantees (20261016090000): existing
// services get version 1 and keep everything else; the weekly hours,
// appointments and their service snapshots are untouched; the new
// functions work on the existing rows.

const BEFORE = "20261015090000";

let owner: Professional;
let businessId: string;
let service: string;
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
       (select md5(string_agg(
          (s.id, s.name, s.description, s.duration_minutes, s.price_cents,
           s.active, s.display_order, s.created_at, s.updated_at)::text,
          '|' order by s.id))
        from public.services s where s.business_id = $1) as services,
       (select md5(string_agg(h::text, '|' order by h.id))
        from public.business_hours h where h.business_id = $1) as hours,
       (select md5(string_agg(a::text, '|' order by a.id))
        from public.appointments a where a.business_id = $1) as appointments`,
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
    await connection.query("commit");
    return rows as T[];
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

beforeAll(async () => {
  resetTo(BEFORE);
  owner = await createProfessional("upgrade-setup-guarantees");
  businessId = (await createBusiness(owner.userId)).id;
  service = await createService(businessId, {
    name: "Coupe",
    durationMinutes: 60,
    priceCents: 4000,
  });
  await createService(businessId, { name: "Couleur", priceCents: 6000 });
  await setWeeklyHours(businessId, [
    [1, "09:00", "12:00"],
    [1, "14:00", "18:00"],
  ]);
  const client = await createClientRecord(businessId, "upgrade@x.test");
  await insertAppointment({
    businessId,
    clientId: client,
    serviceId: service,
    startsAt: inDays(-3, 9),
    endsAt: inDays(-3, 10),
    status: "completed",
  });
  rowsBefore = await tables();

  migrateUp();
});

describe("upgrading to the setup write guarantees", () => {
  it("gives existing services version 1 and rewrites nothing", async () => {
    const { rows } = await db.query(
      "select distinct version from public.services where business_id = $1",
      [businessId],
    );
    expect(rows).toEqual([{ version: 1 }]);
    expect(await tables()).toBe(rowsBefore);
  });

  it("edits an existing service on its version, and creates once per request", async () => {
    const [stale] = await asOwner<{ count: number }>(
      `with edit as (
         update public.services set price_cents = 4500
         where id = $1 and version = 2 returning id)
       select count(*)::int as count from edit`,
      [service],
    );
    expect(stale).toEqual({ count: 0 });
    const [edited] = await asOwner<{ version: number }>(
      "update public.services set price_cents = 4500 where id = $1 and version = 1 returning version",
      [service],
    );
    expect(edited).toEqual({ version: 2 });

    const requestId = randomUUID();
    const create = () =>
      asOwner<{ status: string; service_id: string }>(
        `select * from public.create_service(
           p_business_id => $1, p_request_id => $2, p_name => 'Soin',
           p_duration_minutes => 30, p_price_cents => 2000)`,
        [businessId, requestId],
      );
    const [created] = await create();
    const [replayed] = await create();
    expect(created!.status).toBe("created");
    expect(replayed).toEqual({
      status: "replayed",
      service_id: created!.service_id,
    });
    const [last] = await asOwner<{ display_order: number }>(
      "select display_order from public.services where id = $1",
      [created!.service_id],
    );
    // After the existing services (both at 0, written before positions).
    expect(last).toEqual({ display_order: 1 });
  });

  it("replaces the existing week only on the basis of what it is", async () => {
    const week = JSON.stringify([
      { weekday: 1, starts_at: "09:00", ends_at: "12:00" },
      { weekday: 1, starts_at: "14:00", ends_at: "18:00" },
    ]);
    const next = JSON.stringify([
      { weekday: 2, starts_at: "10:00", ends_at: "16:00" },
    ]);
    await expect(
      asOwner("select * from public.replace_business_hours($1, $2, '[]')", [
        businessId,
        next,
      ]),
    ).rejects.toMatchObject({ message: "stale_business_hours" });
    const replaced = await asOwner<{ weekday: number }>(
      "select weekday from public.replace_business_hours($1, $2, $3)",
      [businessId, next, week],
    );
    expect(replaced).toEqual([{ weekday: 2 }]);
    await expect(
      asOwner("select * from public.replace_business_hours($1, $2)", [
        businessId,
        week,
      ]),
    ).rejects.toMatchObject({ code: "42883" });
  });
});
