import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade of a populated database from customer management and notes
// (20261014090000) to notes in the relationship timeline (20261015090000):
// the migration only replaces public.crm_client_timeline. Existing notes are
// read as they are; nothing is rewritten.

const BEFORE = "20261014090000";

let owner: Professional;
let businessId: string;
let clientId: string;
let visit: string;
let note: string;
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
       (select md5(string_agg(n::text, '|' order by n.id)) from public.client_notes n where n.business_id = $1) as notes,
       (select md5(string_agg(r::text, '|' order by r.request_id)) from private.client_note_requests r where r.business_id = $1) as requests,
       (select md5(string_agg(a::text, '|' order by a.id)) from public.appointments a where a.business_id = $1) as appointments`,
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
  owner = await createProfessional("upgrade-crm-tl-notes");
  businessId = (await createBusiness(owner.userId, { timezone: "UTC" })).id;
  const service = await createService(businessId, {
    name: "Coupe",
    durationMinutes: 60,
    priceCents: 4000,
  });
  clientId = (
    await db.query<{ id: string }>(
      "insert into public.clients (business_id, first_name) values ($1, 'Léa') returning id",
      [businessId],
    )
  ).rows[0]!.id;
  visit = await insertAppointment({
    businessId,
    clientId,
    serviceId: service,
    startsAt: inDays(-7, 9),
    endsAt: inDays(-7, 10),
    status: "completed",
  });
  const [created] = await asOwner<{ note_id: string }>(
    "select * from public.crm_create_client_note($1, $2, 'Note écrite avant la mise à jour', gen_random_uuid())",
    [businessId, clientId],
  );
  note = created!.note_id;
  rowsBefore = await tables();

  migrateUp();
});

describe("upgrading to notes in the relationship timeline", () => {
  it("reads the existing note as a timeline event, at its date; rewrites nothing", async () => {
    const events = await asOwner<{
      event_id: string;
      kind: string;
      data: Record<string, unknown>;
    }>(
      "select event_id, kind, data from public.crm_client_timeline($1, $2, 20)",
      [businessId, clientId],
    );
    expect(events.map((event) => event.event_id)).toEqual([
      `note:${note}`,
      `appointment:${visit}`,
    ]);
    expect(events[0]).toMatchObject({
      kind: "note",
      data: {
        id: note,
        content: "Note écrite avant la mise à jour",
        version: 1,
        createdBy: owner.userId,
        updatedBy: null,
      },
    });
    expect(await tables()).toBe(rowsBefore);
  });
});
