import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { outboundEvent } from "@/features/calendar/data/outbound-event";

import {
  createBusiness,
  createProfessional,
  createService,
  db,
  insertAppointment,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade of a populated database from the schema of main before CRM V1
// (20261011090000) to the customer identity (20261012090000). Customers of
// one business whose stored emails are the same canonical email (variants
// of whitespace, case or Unicode form left by direct writes) become one;
// every appointment, whatever its status or date, follows; appointment
// snapshots keep each appointment's own contact; another business is never
// touched. Loyalty, redemptions and email history follow the survivor
// unchanged. Google: the merge is internal; it never enrolls an appointment
// in the outbound calendar, and an existing mirror is due again only when
// its title (the first name) changes.

const BEFORE_CRM = "20261011090000";
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

let businessA: string;
let businessB: string;
let slugA: string;
let serviceA: string;
let businessG: string;
const customer: Record<string, string> = {};
const appointment: Record<string, string> = {};
let versionsBefore: Map<string, { version: number; updated_at: Date }>;
type Row = Record<string, unknown> & { id: string; client_id: string | null };
const historyBefore: Record<
  "loyalty_events" | "reward_redemptions" | "email_events",
  Row[]
> = { loyalty_events: [], reward_redemptions: [], email_events: [] };
let mirrorsBefore: Map<string, Record<string, unknown>>;

/** The rows of `table` in businesses A and B; after the upgrade, only those
 *  that existed before it (a booking made after it adds its own email). */
async function history(table: keyof typeof historyBefore) {
  const order = table === "reward_redemptions" ? "redeemed_at" : "created_at";
  const known = historyBefore[table].map((row) => row.id);
  const { rows } = await db.query<Row>(
    `select * from public.${table}
     where business_id = any($1) and (cardinality($2::uuid[]) = 0 or id = any($2))
     order by ${order}, id`,
    [[businessA, businessB], known],
  );
  return rows;
}

async function mirrorsOf(businessId: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    "select * from private.appointment_calendar_mirrors where business_id = $1",
    [businessId],
  );
  return new Map(rows.map((row) => [row.appointment_id as string, row]));
}

const inDays = (days: number, hour: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

async function addCustomer(
  key: string,
  businessId: string,
  fields: {
    firstName: string;
    email: string | null;
    lastName?: string;
    phone?: string;
    notes?: string;
    token?: string;
    createdAt: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.clients
       (business_id, first_name, last_name, email, phone, internal_notes, loyalty_token_hash, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      businessId,
      fields.firstName,
      fields.lastName ?? null,
      fields.email,
      fields.phone ?? null,
      fields.notes ?? null,
      fields.token ?? null,
      fields.createdAt,
    ],
  );
  customer[key] = rows[0]!.id;
}

async function addAppointment(
  key: string,
  businessId: string,
  service: string,
  client: string,
  days: number,
  status?: "completed" | "cancelled" | "no_show",
) {
  appointment[key] = await insertAppointment({
    businessId,
    clientId: client,
    serviceId: service,
    startsAt: inDays(days, 9),
    endsAt: inDays(days, 10),
    status,
  });
}

beforeAll(async () => {
  resetTo(BEFORE_CRM);
  const owner = await createProfessional("upgrade-crm");
  const a = await createBusiness(owner.userId, {
    timezone: "UTC",
    settings: {
      slot_interval_minutes: 30,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
    },
  });
  businessA = a.id;
  slugA = a.slug;
  businessB = (await createBusiness(owner.userId, { timezone: "UTC" })).id;
  serviceA = await createService(businessA, { durationMinutes: 60 });
  const serviceB = await createService(businessB, { durationMinutes: 60 });
  await db.query(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
     select $1, d, '06:00', '22:00' from generate_series(0, 6) d`,
    [businessA],
  );

  // Business A: three records of one canonical email (the earliest first).
  await addCustomer("lea", businessA, {
    firstName: "Léa",
    email: "lea@x.test",
    notes: "Allergie latex",
    createdAt: "2026-01-01T10:00:00Z",
  });
  await addCustomer("leaSpaces", businessA, {
    firstName: "Lea",
    lastName: "Martin",
    email: " lea@x.test ",
    phone: "0611111111",
    notes: "Préfère le matin",
    token: "token-spaces",
    createdAt: "2026-02-01T10:00:00Z",
  });
  await addCustomer("leaUpper", businessA, {
    firstName: "LEA",
    email: "  LEA@X.TEST",
    phone: "0622222222",
    createdAt: "2026-03-01T10:00:00Z",
  });
  // Tab and no-break space around it: the same address.
  await addCustomer("leaTab", businessA, {
    firstName: "Léa",
    email: "\tLea@X.test\u00a0",
    createdAt: "2026-04-01T10:00:00Z",
  });
  // Two Unicode forms of one address.
  await addCustomer("zoeDecomposed", businessA, {
    firstName: "Zoé",
    email: "zoe\u0301@x.test",
    createdAt: "2026-01-05T10:00:00Z",
  });
  await addCustomer("zoeComposed", businessA, {
    firstName: "Zoé",
    email: "ZO\u00c9@x.test",
    createdAt: "2026-01-06T10:00:00Z",
  });
  // An empty email is no identity.
  await addCustomer("blank", businessA, {
    firstName: "Sans",
    email: "  ",
    createdAt: "2026-01-07T10:00:00Z",
  });
  await addCustomer("alone", businessA, {
    firstName: "Nora",
    email: "nora@x.test",
    createdAt: "2026-01-08T10:00:00Z",
  });
  // Business B: the same email, its own customer.
  await addCustomer("leaB", businessB, {
    firstName: "Léa B",
    email: " Lea@X.test",
    createdAt: "2026-01-02T10:00:00Z",
  });

  await addAppointment(
    "leaPast",
    businessA,
    serviceA,
    customer.lea!,
    -30,
    "completed",
  );
  await addAppointment(
    "spacesCancelled",
    businessA,
    serviceA,
    customer.leaSpaces!,
    5,
    "cancelled",
  );
  await addAppointment(
    "spacesNoShow",
    businessA,
    serviceA,
    customer.leaSpaces!,
    -10,
    "no_show",
  );
  await addAppointment(
    "upperFuture",
    businessA,
    serviceA,
    customer.leaUpper!,
    6,
  );
  await addAppointment(
    "zoeComposed",
    businessA,
    serviceA,
    customer.zoeComposed!,
    7,
  );
  await addAppointment("blank", businessA, serviceA, customer.blank!, 8);
  await addAppointment("alone", businessA, serviceA, customer.alone!, 9);
  await addAppointment("leaB", businessB, serviceB, customer.leaB!, 5);
  await db.query(
    `insert into public.email_events (business_id, client_id, appointment_id, type, recipient_email, payload, dedupe_key)
     values ($1, $2, $3::uuid, 'booking_confirmation', 'lea@x.test', '{}', 'upgrade-crm-' || $3::text)`,
    [businessA, customer.leaSpaces, appointment.spacesCancelled],
  );
  await db.query(
    `insert into public.email_events
       (business_id, client_id, appointment_id, type, recipient_email, dedupe_key, status,
        scheduled_for, attempt_count, last_attempt_at, sent_at, provider_message_id, created_at)
     values
       ($1, $2, $3, 'booking_confirmation', 'lea@x.test', 'upgrade-crm-sent', 'sent',
        '2026-03-02T09:00:00Z', 1, '2026-03-02T09:00:05Z', '2026-03-02T09:00:06Z', 'msg-1', '2026-03-02T09:00:00Z'),
       ($4, $5, $6, 'booking_confirmation', 'lea@x.test', 'upgrade-crm-b', 'pending',
        '2026-03-03T09:00:00Z', 0, null, null, null, '2026-03-03T09:00:00Z')`,
    [
      businessA,
      customer.leaUpper,
      appointment.upperFuture,
      businessB,
      customer.leaB,
      appointment.leaB,
    ],
  );

  // Loyalty ledger and a redemption, on the survivor and on records merged
  // into it, plus another business.
  const loyalty = async (
    businessId: string,
    client: string,
    type: "appointment_completed" | "manual_adjustment" | "reward_redeemed",
    points: number,
    key: string,
    createdAt: string,
    appointmentId: string | null = null,
  ) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.loyalty_events
         (business_id, client_id, appointment_id, type, points_delta, reason, idempotency_key, created_at)
       values ($1, $2, $3, $4, $5, 'upgrade', $6, $7) returning id`,
      [businessId, client, appointmentId, type, points, key, createdAt],
    );
    return rows[0]!.id;
  };
  await loyalty(
    businessA,
    customer.lea!,
    "appointment_completed",
    1,
    "k-lea-completed",
    "2026-01-10T10:00:00Z",
    appointment.leaPast,
  );
  await loyalty(
    businessA,
    customer.leaSpaces!,
    "manual_adjustment",
    5,
    "k-spaces-gift",
    "2026-02-10T10:00:00Z",
  );
  await loyalty(
    businessA,
    customer.leaTab!,
    "manual_adjustment",
    3,
    "k-tab-gift",
    "2026-04-10T10:00:00Z",
  );
  const redeemed = await loyalty(
    businessA,
    customer.leaSpaces!,
    "reward_redeemed",
    -4,
    "k-spaces-redeem",
    "2026-02-20T10:00:00Z",
  );
  await loyalty(
    businessA,
    customer.alone!,
    "manual_adjustment",
    2,
    "k-alone-gift",
    "2026-01-20T10:00:00Z",
  );
  await loyalty(
    businessB,
    customer.leaB!,
    "manual_adjustment",
    7,
    "k-b-gift",
    "2026-01-21T10:00:00Z",
  );
  const { rows: reward } = await db.query<{ id: string }>(
    `insert into public.rewards (business_id, name, points_required, reward_type)
     values ($1, 'Soin offert', 4, 'free_service') returning id`,
    [businessA],
  );
  await db.query(
    `insert into public.reward_redemptions
       (business_id, reward_id, client_id, loyalty_event_id, points_spent, redeemed_at)
     values ($1, $2, $3, $4, 4, '2026-02-20T10:00:00Z')`,
    [businessA, reward[0]!.id, customer.leaSpaces, redeemed],
  );
  for (const table of Object.keys(
    historyBefore,
  ) as (keyof typeof historyBefore)[]) {
    historyBefore[table] = await history(table);
  }

  // Business G: Google outbound active on a healthy dedicated calendar.
  const g = await createBusiness(owner.userId, { timezone: "UTC" });
  businessG = g.id;
  const serviceG = await createService(businessG, {
    name: "Coupe",
    durationMinutes: 60,
  });
  await addCustomer("emma", businessG, {
    firstName: "Emma",
    email: "emma@g.test",
    createdAt: "2026-01-01T10:00:00Z",
  });
  // Same canonical email, same first name: the same Google title.
  await addCustomer("emmaDup", businessG, {
    firstName: "Emma",
    email: "  EMMA@g.test",
    phone: "0633333333",
    createdAt: "2026-02-01T10:00:00Z",
  });
  await addCustomer("amy", businessG, {
    firstName: "Emma",
    email: "amy@g.test",
    createdAt: "2026-01-01T11:00:00Z",
  });
  // Same canonical email, another first name: the Google title changes.
  await addCustomer("emmyDup", businessG, {
    firstName: "Emmy",
    email: "\tAMY@g.test\t",
    createdAt: "2026-02-01T11:00:00Z",
  });
  // Never enrolled: before outbound existed for this business.
  await addAppointment(
    "gPast",
    businessG,
    serviceG,
    customer.emmyDup!,
    -20,
    "completed",
  );
  await addAppointment(
    "gPastCancelled",
    businessG,
    serviceG,
    customer.emmyDup!,
    -15,
    "cancelled",
  );
  await addAppointment(
    "gPastConfirmed",
    businessG,
    serviceG,
    customer.emmaDup!,
    -12,
  );
  await addAppointment("gFuture", businessG, serviceG, customer.emmaDup!, 20);
  const { rows: connection } = await db.query<{ id: string }>(
    `insert into public.calendar_connections (business_id, provider, provider_account_id, account_email, scopes)
     values ($1, 'google', $2, 'g@gmail.test', $3) returning id`,
    [businessG, `sub-${randomUUID()}`, [WRITE_SCOPE]],
  );
  await db.query(
    `insert into private.calendar_outbound
       (business_id, connection_id, provider_account_id, status, provider_calendar_id, enabled_at)
     select $1, c.id, c.provider_account_id, 'active', 'cal-g', now()
     from public.calendar_connections c where c.id = $2`,
    [businessG, connection[0]!.id],
  );
  // Enrolled by the trigger, then applied by a worker.
  await addAppointment("gSame", businessG, serviceG, customer.emmaDup!, 5);
  await addAppointment("gChanged", businessG, serviceG, customer.emmyDup!, 6);
  await addAppointment("gSurvivor", businessG, serviceG, customer.emma!, 7);
  await db.query(
    `update private.appointment_calendar_mirrors
     set applied_revision = desired_revision, provider_calendar_id = 'cal-g',
         applied_at = now() - interval '1 hour', next_attempt_at = now() - interval '1 hour'
     where business_id = $1`,
    [businessG],
  );
  mirrorsBefore = await mirrorsOf(businessG);

  const { rows } = await db.query<{
    id: string;
    version: number;
    updated_at: Date;
  }>(
    "select id, version, updated_at from public.appointments where business_id = any($1)",
    [[businessA, businessB, businessG]],
  );
  versionsBefore = new Map(rows.map((row) => [row.id, row]));

  migrateUp();
});

async function customersOf(businessId: string) {
  const { rows } = await db.query(
    `select id, first_name, last_name, email::text as email, phone, internal_notes, loyalty_token_hash
     from public.clients where business_id = $1 order by created_at, id`,
    [businessId],
  );
  return rows;
}

async function appointmentRow(id: string) {
  const { rows } = await db.query(
    `select client_id, status::text as status, version, updated_at,
            client_first_name_snapshot as "firstName",
            client_last_name_snapshot as "lastName",
            client_email_snapshot as email,
            client_phone_snapshot as phone
     from public.appointments where id = $1`,
    [id],
  );
  return rows[0];
}

describe("upgrading customers to one identity per canonical email", () => {
  it("merges each business's variants into its earliest record, deterministically", async () => {
    expect(await customersOf(businessA)).toEqual([
      {
        id: customer.lea,
        first_name: "Léa",
        // Missing values from the latest record that has one.
        last_name: "Martin",
        email: "lea@x.test",
        phone: "0622222222",
        // Notes are never lost: the others' appended, oldest first.
        internal_notes: "Allergie latex\n\nPréfère le matin",
        loyalty_token_hash: "token-spaces",
      },
      expect.objectContaining({
        id: customer.zoeDecomposed,
        email: "zo\u00e9@x.test",
      }),
      expect.objectContaining({ id: customer.blank, email: null }),
      expect.objectContaining({
        id: customer.alone,
        email: "nora@x.test",
        phone: null,
      }),
    ]);
  });

  it("every appointment of the group, any status or date, now belongs to the survivor; its snapshot is its own former record", async () => {
    expect(await appointmentRow(appointment.leaPast!)).toMatchObject({
      client_id: customer.lea,
      status: "completed",
      firstName: "Léa",
      lastName: null,
      email: "lea@x.test",
      phone: null,
    });
    expect(await appointmentRow(appointment.spacesCancelled!)).toMatchObject({
      client_id: customer.lea,
      status: "cancelled",
      firstName: "Lea",
      lastName: "Martin",
      email: "lea@x.test",
      phone: "0611111111",
    });
    expect(await appointmentRow(appointment.spacesNoShow!)).toMatchObject({
      client_id: customer.lea,
      status: "no_show",
    });
    expect(await appointmentRow(appointment.upperFuture!)).toMatchObject({
      client_id: customer.lea,
      status: "confirmed",
      firstName: "LEA",
      email: "lea@x.test",
      phone: "0622222222",
    });
    expect(await appointmentRow(appointment.zoeComposed!)).toMatchObject({
      client_id: customer.zoeDecomposed,
      email: "zo\u00e9@x.test",
    });
    expect(await appointmentRow(appointment.blank!)).toMatchObject({
      client_id: customer.blank,
      firstName: "Sans",
      email: null,
    });
    const { rows } = await db.query(
      "select client_id from public.email_events where appointment_id = $1",
      [appointment.spacesCancelled],
    );
    expect(rows).toEqual([{ client_id: customer.lea }]);
  });

  it("filling snapshots is not an edit: appointments that keep their customer keep their version and updated_at; moved ones are versioned", async () => {
    for (const key of ["leaPast", "blank", "alone", "leaB"]) {
      const before = versionsBefore.get(appointment[key]!)!;
      expect(await appointmentRow(appointment[key]!)).toMatchObject({
        version: before.version,
        updated_at: before.updated_at,
      });
    }
    // Moved to the merged customer: a real change (stale forms are refused,
    // a calendar mirror would follow).
    for (const key of ["spacesCancelled", "upperFuture", "zoeComposed"]) {
      const before = versionsBefore.get(appointment[key]!)!;
      expect((await appointmentRow(appointment[key]!)).version).toBe(
        before.version + 1,
      );
    }
    const { rows } = await db.query(
      "select count(*)::int as n from public.appointments where client_first_name_snapshot is null",
    );
    expect(rows[0].n).toBe(0);
  });

  it("never touches another business with the same email (only its stored email becomes canonical)", async () => {
    expect(await customersOf(businessB)).toEqual([
      expect.objectContaining({
        id: customer.leaB,
        first_name: "Léa B",
        email: "lea@x.test",
      }),
    ]);
    expect(await appointmentRow(appointment.leaB!)).toMatchObject({
      client_id: customer.leaB,
      firstName: "Léa B",
      email: "lea@x.test",
    });
  });

  it("after the upgrade, a booking with yet another variant resolves to the merged customer", async () => {
    const { rows } = await db.query<{ appointment_id: string }>(
      `select appointment_id from private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Léa', $4)`,
      [slugA, serviceA, inDays(12, 11), "\u3000Lea@X.Test\t"],
    );
    expect(await appointmentRow(rows[0]!.appointment_id)).toMatchObject({
      client_id: customer.lea,
      firstName: "Léa",
      email: "lea@x.test",
    });
    expect(await customersOf(businessA)).toHaveLength(4);
  });
});

const survivorOf = () =>
  new Map([
    [customer.leaSpaces!, customer.lea!],
    [customer.leaUpper!, customer.lea!],
    [customer.leaTab!, customer.lea!],
    [customer.zoeComposed!, customer.zoeDecomposed!],
  ]);

describe("upgrading loyalty, redemptions and email history with the customers", () => {
  it("every row is kept, unchanged but for client_id, which points to the survivor", async () => {
    const survivor = survivorOf();
    for (const table of ["loyalty_events", "reward_redemptions"] as const) {
      const before = historyBefore[table];
      expect(before.length).toBeGreaterThan(0);
      expect(await history(table)).toEqual(
        before.map((row) => ({
          ...row,
          client_id: survivor.get(row.client_id!) ?? row.client_id,
        })),
      );
    }
    // Email history: same rows and times; updated_at records the relink of
    // the rows that changed customer, and only of those.
    const before = historyBefore.email_events;
    expect(before).toHaveLength(3);
    const after = await history("email_events");
    const withoutUpdatedAt = (row: Row) => {
      const copy = { ...row };
      delete copy.updated_at;
      return copy;
    };
    expect(after.map(withoutUpdatedAt)).toEqual(
      before.map((row) => ({
        ...withoutUpdatedAt(row),
        client_id: survivor.get(row.client_id!) ?? row.client_id,
      })),
    );
    for (const [index, row] of before.entries()) {
      if (survivor.has(row.client_id!)) continue;
      expect(after[index]!.updated_at).toEqual(row.updated_at);
    }
  });

  it("loyalty balances: unchanged per business; the survivor holds its group's", async () => {
    const { rows } = await db.query(
      `select business_id, client_id, sum(points_delta)::int as balance
       from public.loyalty_events where business_id = any($1)
       group by 1, 2 order by 3`,
      [[businessA, businessB]],
    );
    expect(rows).toEqual([
      { business_id: businessA, client_id: customer.alone, balance: 2 },
      // 1 + 5 + 3 - 4, ledgers of three records of one address.
      { business_id: businessA, client_id: customer.lea, balance: 5 },
      { business_id: businessB, client_id: customer.leaB, balance: 7 },
    ]);
    const { rows: redemption } = await db.query(
      `select r.client_id, r.points_spent, e.client_id as event_client
       from public.reward_redemptions r
       join public.loyalty_events e on e.id = r.loyalty_event_id
       where r.business_id = $1`,
      [businessA],
    );
    expect(redemption).toEqual([
      { client_id: customer.lea, points_spent: 4, event_client: customer.lea },
    ]);
  });
});

describe("upgrading customers of a business mirrored to Google", () => {
  it("records are merged as anywhere else", async () => {
    expect((await customersOf(businessG)).map((row) => row.id)).toEqual([
      customer.emma,
      customer.amy,
    ]);
    for (const key of ["gPast", "gPastCancelled", "gChanged"]) {
      expect(await appointmentRow(appointment[key]!)).toMatchObject({
        client_id: customer.amy,
        firstName: "Emmy",
        email: "amy@g.test",
      });
    }
    for (const key of ["gPastConfirmed", "gFuture", "gSame"]) {
      expect(await appointmentRow(appointment[key]!)).toMatchObject({
        client_id: customer.emma,
        firstName: "Emma",
        phone: "0633333333",
      });
    }
  });

  it("never enrolled appointments (past, cancelled, past confirmed, future) are still not enrolled: no mirror, no write", async () => {
    const mirrors = await mirrorsOf(businessG);
    for (const key of [
      "gPast",
      "gPastCancelled",
      "gPastConfirmed",
      "gFuture",
    ]) {
      expect(mirrors.has(appointment[key]!)).toBe(false);
    }
    expect([...mirrors.keys()].sort()).toEqual(
      [
        appointment.gSame!,
        appointment.gChanged!,
        appointment.gSurvivor!,
      ].sort(),
    );
  });

  it("an existing mirror whose title stays the same is untouched (no revision, no repair, no write)", async () => {
    const mirrors = await mirrorsOf(businessG);
    expect(mirrors.get(appointment.gSame!)).toEqual(
      mirrorsBefore.get(appointment.gSame!),
    );
    expect(mirrors.get(appointment.gSurvivor!)).toEqual(
      mirrorsBefore.get(appointment.gSurvivor!),
    );
  });

  it("an existing mirror whose title changes is due exactly once, for the survivor's first name only", async () => {
    const before = mirrorsBefore.get(appointment.gChanged!)!;
    const after = (await mirrorsOf(businessG)).get(appointment.gChanged!)!;
    expect(after).toMatchObject({
      desired_revision: String(Number(before.desired_revision) + 1),
      applied_revision: before.applied_revision,
      repair_generation: before.repair_generation,
      repaired_generation: before.repaired_generation,
      provider_calendar_id: "cal-g",
      attempts: 0,
      last_error: null,
    });
    const { rows: status } = await db.query(
      "select private.outbound_status($1) as status",
      [businessG],
    );
    expect(status[0].status).toMatchObject({ pendingCount: 1 });

    // What the writer gets: the survivor's first name and the service, no
    // email, phone or customer id.
    const { rows } = await db.query(
      "select public.calendar_outbound_claim_mirrors(10, $1, 10) as claims",
      [businessG],
    );
    const claims = rows[0].claims as Parameters<typeof outboundEvent>[0][];
    expect(claims.map((claim) => claim.appointmentId)).toEqual([
      appointment.gChanged,
    ]);
    const event = outboundEvent({
      ...claims[0]!,
      eventId: `bk${appointment.gChanged!.replaceAll("-", "")}`,
    });
    expect(event.summary).toBe("Emma — Coupe");
    const sent = JSON.stringify([claims, event]).toLowerCase();
    for (const secret of [
      "amy@g.test",
      "emma@g.test",
      "0633333333",
      customer.amy!,
      customer.emmyDup!,
      customer.emma!,
    ]) {
      expect(sent).not.toContain(secret.toLowerCase());
    }
  });

  it("after the migration, a change of client_id records a mirror change as before (the merge mark ended with its transaction)", async () => {
    const { rows: setting } = await db.query(
      "select coalesce(current_setting('booking.crm_customer_merge', true), '') as value",
    );
    expect(setting[0].value).not.toBe("on");
    const before = (await mirrorsOf(businessG)).get(appointment.gSame!)!;
    await db.query(
      "update public.appointments set client_id = $2 where id = $1",
      [appointment.gSame, customer.amy],
    );
    const after = (await mirrorsOf(businessG)).get(appointment.gSame!)!;
    expect(after.desired_revision).toBe(
      String(Number(before.desired_revision) + 1),
    );
  });
});
