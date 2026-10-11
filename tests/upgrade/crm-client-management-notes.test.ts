import { randomUUID } from "node:crypto";

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

// Upgrade of a populated database from the relationship read model
// (20261013090000) to customer management and notes (20261014090000): the
// migration adds columns with defaults, a table and functions. Existing
// records are read as they are: nothing is rewritten, merged or moved, and
// the legacy free-text notes are not migrated into dated notes.

const BEFORE = "20261013090000";

let owner: Professional;
let businessId: string;
let lea: string;
let anonymous: string;
let visit: string;
let rowsBefore: string;

const LEGACY = "Allergie au latex\n\nPréfère le samedi";

const inDays = (days: number, hour: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

/** Every column that existed before the upgrade, row by row. */
async function tables() {
  const { rows } = await db.query(
    `select
       (select md5(string_agg(
          (c.id, c.business_id, c.first_name, c.last_name, c.email, c.phone,
           c.internal_notes, c.loyalty_token_hash, c.created_at, c.updated_at)::text,
          '|' order by c.id))
        from public.clients c where c.business_id = $1) as clients,
       (select md5(string_agg(a::text, '|' order by a.id))
        from public.appointments a where a.business_id = $1) as appointments,
       (select md5(string_agg(e::text, '|' order by e.id))
        from public.email_events e where e.business_id = $1) as emails`,
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
  owner = await createProfessional("upgrade-crm-manage");
  businessId = (await createBusiness(owner.userId, { timezone: "UTC" })).id;
  const service = await createService(businessId, {
    name: "Coupe",
    durationMinutes: 60,
    priceCents: 4000,
  });
  lea = (
    await db.query<{ id: string }>(
      `insert into public.clients (business_id, first_name, last_name, email, phone, internal_notes)
       values ($1, 'Léa', 'Martin', 'lea@x.test', '0601020304', $2)
       returning id`,
      [businessId, LEGACY],
    )
  ).rows[0]!.id;
  anonymous = (
    await db.query<{ id: string }>(
      `insert into public.clients (business_id, first_name)
       values ($1, 'Sans email') returning id`,
      [businessId],
    )
  ).rows[0]!.id;
  visit = await insertAppointment({
    businessId,
    clientId: lea,
    serviceId: service,
    startsAt: inDays(-7, 9),
    endsAt: inDays(-7, 10),
    status: "completed",
  });
  await insertAppointment({
    businessId,
    clientId: lea,
    serviceId: service,
    startsAt: inDays(7, 9),
    endsAt: inDays(7, 10),
  });
  await db.query(
    `insert into public.email_events (business_id, client_id, appointment_id, type, recipient_email, dedupe_key)
     values ($1, $2, $3, 'booking_confirmation', 'lea@x.test', 'upgrade-crm-manage')`,
    [businessId, lea, visit],
  );
  rowsBefore = await tables();

  migrateUp();
});

describe("upgrading to customer management and notes", () => {
  it("rewrites nothing: records, appointments, emails and legacy notes stay as they were", async () => {
    expect(await tables()).toBe(rowsBefore);
    const { rows } = await db.query(
      `select id, version, creation_request_id, creation_request_fingerprint, internal_notes
       from public.clients where business_id = $1 order by first_name`,
      [businessId],
    );
    expect(rows).toEqual([
      {
        id: lea,
        version: 1,
        creation_request_id: null,
        creation_request_fingerprint: null,
        internal_notes: LEGACY,
      },
      {
        id: anonymous,
        version: 1,
        creation_request_id: null,
        creation_request_fingerprint: null,
        internal_notes: null,
      },
    ]);
    // No legacy text was turned into a dated note.
    const { rows: notes } = await db.query(
      "select count(*)::int as n from public.client_notes",
    );
    expect(notes[0]).toEqual({ n: 0 });
  });

  it("existing customers can be edited and annotated; history keeps its contact", async () => {
    const [update] = await asOwner<{ status: string }>(
      "select * from public.crm_update_client($1, $2, 1, 'Léa', 'Martin', 'lea.martin@x.test', '0601020304')",
      [businessId, lea],
    );
    expect(update).toMatchObject({ status: "updated" });

    const [note] = await asOwner<{ status: string; note_id: string }>(
      "select * from public.crm_create_client_note($1, $2, 'Première note datée', $3)",
      [businessId, lea, randomUUID()],
    );
    expect(note).toMatchObject({ status: "created" });

    const [page] = await asOwner<{ page: Record<string, never> }>(
      "select public.crm_list_client_notes($1, $2) as page",
      [businessId, lea],
    );
    expect(page!.page).toMatchObject({
      legacyNotes: LEGACY,
      notes: [
        { id: note!.note_id, content: "Première note datée", version: 1 },
      ],
    });

    const { rows } = await db.query(
      `select client_email_snapshot, version from public.appointments
       where client_id = $1 order by starts_at`,
      [lea],
    );
    expect(rows).toEqual([
      { client_email_snapshot: "lea@x.test", version: 1 },
      { client_email_snapshot: "lea@x.test", version: 1 },
    ]);
    const { rows: emails } = await db.query(
      "select recipient_email::text as recipient from public.email_events where client_id = $1",
      [lea],
    );
    expect(emails).toEqual([{ recipient: "lea@x.test" }]);
    expect(
      (
        await db.query(
          "select internal_notes from public.clients where id = $1",
          [lea],
        )
      ).rows[0],
    ).toEqual({ internal_notes: LEGACY });
  });
});
