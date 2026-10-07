import { beforeAll, describe, expect, it } from "vitest";

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
// touched.

const BEFORE_CRM = "20261011090000";

let businessA: string;
let businessB: string;
let slugA: string;
let serviceA: string;
const customer: Record<string, string> = {};
const appointment: Record<string, string> = {};
let versionsBefore: Map<string, { version: number; updated_at: Date }>;

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
  // Two Unicode forms of one address.
  await addCustomer("zoeDecomposed", businessA, {
    firstName: "Zoé",
    email: "zoé@x.test",
    createdAt: "2026-01-05T10:00:00Z",
  });
  await addCustomer("zoeComposed", businessA, {
    firstName: "Zoé",
    email: "ZOÉ@x.test",
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

  const { rows } = await db.query<{
    id: string;
    version: number;
    updated_at: Date;
  }>(
    "select id, version, updated_at from public.appointments where business_id = any($1)",
    [[businessA, businessB]],
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
        email: "zoé@x.test",
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
      email: "zoé@x.test",
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
      `select appointment_id from private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Léa', '  Lea@X.Test ')`,
      [slugA, serviceA, inDays(12, 11)],
    );
    expect(await appointmentRow(rows[0]!.appointment_id)).toMatchObject({
      client_id: customer.lea,
      firstName: "Léa",
      email: "lea@x.test",
    });
    expect(await customersOf(businessA)).toHaveLength(4);
  });
});
