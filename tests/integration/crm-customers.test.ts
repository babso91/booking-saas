import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  insertAppointment,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
} from "./support/transactions";

// CRM V1: the customer (public.clients) of a business, its identity (the
// canonical email, within the business only), its resolution by every
// creation path, the contact snapshots of appointments, and tenant
// isolation. Real PostgreSQL, real API roles.

const D = dateInDays(12);
const at = (time: string, date = D) => `${date}T${time}:00.000Z`;
const anon = anonClient();

let owner: Professional;
let business: TestBusiness;
let service: string;

async function newBusiness(professional: Professional) {
  const created = await createBusiness(professional.userId, {
    timezone: "UTC",
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 365,
    },
  });
  await setWeeklyHours(created.id, everyDay(["06:00", "22:00"]));
  const createdService = await createService(created.id, {
    name: "Coupe",
    durationMinutes: 30,
  });
  return { business: created, service: createdService };
}

function publicBooking(
  fields: {
    time: string;
    firstName?: string;
    email: string;
    lastName?: string;
    phone?: string;
  },
  target: { business: TestBusiness; service: string } = { business, service },
) {
  return createPublicBooking(
    anon,
    createPublicBookingSchema.parse({
      slug: target.business.slug,
      serviceId: target.service,
      startsAt: at(fields.time),
      firstName: fields.firstName ?? "Léa",
      email: fields.email,
      lastName: fields.lastName,
      phone: fields.phone,
    }),
  );
}

/** The booking RPC itself, with inputs the browser schema would refuse. */
async function rawPublicBooking(
  time: string,
  email: string,
  firstName = "Léa",
) {
  const { rows } = await db.query<{ appointment_id: string }>(
    `select appointment_id from private.create_public_booking_at(now(), $1, $2, $3::timestamptz, $4, $5)`,
    [business.slug, service, at(time), firstName, email],
  );
  return rows[0]!.appointment_id;
}

async function manualCreation(
  professional: Professional,
  businessId: string,
  serviceId: string,
  time: string,
  client:
    | { p_client_id: string }
    | {
        p_client_first_name: string;
        p_client_last_name?: string;
        p_client_email?: string;
        p_client_phone?: string;
      },
) {
  const { data, error } = await professional.client
    .rpc("agenda_create_appointment", {
      p_business_id: businessId,
      p_service_id: serviceId,
      p_starts_at: at(time),
      ...client,
    })
    .single();
  if (error) throw error;
  return data.appointment_id;
}

async function customers(businessId = business.id) {
  const { rows } = await db.query<{
    id: string;
    first_name: string;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    appointments: number;
  }>(
    `select c.id, c.first_name, c.last_name, c.email::text as email, c.phone,
            (select count(*)::int from public.appointments a where a.client_id = c.id) as appointments
     from public.clients c
     where c.business_id = $1
     order by c.created_at, c.id`,
    [businessId],
  );
  return rows;
}

async function snapshot(appointmentId: string) {
  const { rows } = await db.query(
    `select client_id, client_first_name_snapshot as "firstName",
            client_last_name_snapshot as "lastName",
            client_email_snapshot as email,
            client_phone_snapshot as phone
     from public.appointments where id = $1`,
    [appointmentId],
  );
  return rows[0] as {
    client_id: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
}

beforeAll(async () => {
  owner = await createProfessional("crm");
});

beforeEach(async () => {
  ({ business, service } = await newBusiness(owner));
});

describe("identity: the canonical email within one business", () => {
  it("canonical form: NFC, trimmed, lower-cased, empty → null; nothing fuzzy", async () => {
    const { rows } = await db.query<{ value: string | null }>(
      `select private.canonical_email(v) as value
       from unnest($1::text[]) with ordinality as t(v, n) order by n`,
      [
        [
          "  Lea@Example.TEST ",
          "zoé@x.test",
          "first.last+tag@gmail.test",
          "   ",
          "",
        ],
      ],
    );
    expect(rows.map((row) => row.value)).toEqual([
      "lea@example.test",
      "zoé@x.test",
      // Dots and +tags are significant: no provider-specific rule.
      "first.last+tag@gmail.test",
      null,
      null,
    ]);
  });

  it("case, whitespace and Unicode-form variants are one customer; the second booking reuses it", async () => {
    await publicBooking({ time: "09:00", email: "Lea@Example.test" });
    await rawPublicBooking("10:00", "  LEA@EXAMPLE.TEST ");
    await rawPublicBooking("11:00", "zoé@x.test", "Zoé");
    await rawPublicBooking("12:00", "zoé@X.test", "Zoé");

    expect(
      (await customers()).map(({ email, appointments }) => ({
        email,
        appointments,
      })),
    ).toEqual([
      { email: "lea@example.test", appointments: 2 },
      { email: "zoé@x.test", appointments: 2 },
    ]);
  });

  it("different emails are different customers, even with the same name and phone (no phone identity)", async () => {
    await publicBooking({
      time: "09:00",
      email: "a@x.test",
      phone: "0612345678",
    });
    await publicBooking({
      time: "10:00",
      email: "b@x.test",
      phone: "0612345678",
    });
    expect(await customers()).toHaveLength(2);
  });

  it("the same email in two businesses is two customers, never shared", async () => {
    const other = await newBusiness(owner);
    await publicBooking({
      time: "09:00",
      email: "same@x.test",
      firstName: "Léa",
    });
    await publicBooking(
      { time: "09:00", email: "SAME@x.test", firstName: "Lea" },
      other,
    );
    const [mine] = await customers();
    const [theirs] = await customers(other.business.id);
    expect(mine).toMatchObject({
      email: "same@x.test",
      first_name: "Léa",
      appointments: 1,
    });
    expect(theirs).toMatchObject({
      email: "same@x.test",
      first_name: "Lea",
      appointments: 1,
    });
    expect(mine!.id).not.toBe(theirs!.id);
  });

  it("every write of clients.email is canonical, whatever the path; a variant of an existing email is the same identity", async () => {
    const id = await createClientRecord(business.id, "  Direct@X.test ");
    const { rows } = await db.query(
      "select email::text as email from public.clients where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ email: "direct@x.test" });
    await expect(
      createClientRecord(business.id, "DIRECT@x.test   "),
    ).rejects.toMatchObject({ code: "23505" });

    // A member's direct write (RLS DML) is canonicalized too.
    const member = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });
    try {
      await member.connection.query(
        "update public.clients set email = '  Other@X.TEST' where id = $1",
        [id],
      );
      const { rows: updated } = await member.connection.query(
        "select email::text as email from public.clients where id = $1",
        [id],
      );
      expect(updated[0]).toEqual({ email: "other@x.test" });
      await member.connection.query(
        "update public.clients set email = '   ' where id = $1",
        [id],
      );
      const { rows: emptied } = await member.connection.query(
        "select email from public.clients where id = $1",
        [id],
      );
      expect(emptied[0]).toEqual({ email: null });
    } finally {
      await closeTransaction(member, "rollback");
    }
  });
});

describe("resolution of an existing customer", () => {
  it("reuses it: fills a missing last name and phone, never overwrites a value; the appointment keeps what was submitted", async () => {
    const first = await rawPublicBooking("09:00", "lea@x.test", "Léa");
    expect(await customers()).toMatchObject([
      { first_name: "Léa", last_name: null, phone: null },
    ]);

    const second = await publicBooking({
      time: "10:00",
      email: "LEA@x.test",
      firstName: "Lea M",
      lastName: "Martin",
      phone: "0612345678",
    });
    const third = await publicBooking({
      time: "11:00",
      email: "lea@x.test",
      firstName: "Impostor",
      lastName: "Other",
      phone: "0000000000",
    });

    expect(await customers()).toMatchObject([
      {
        first_name: "Léa",
        last_name: "Martin",
        email: "lea@x.test",
        phone: "0612345678",
        appointments: 3,
      },
    ]);
    expect(await snapshot(first)).toMatchObject({
      firstName: "Léa",
      lastName: null,
      email: "lea@x.test",
      phone: null,
    });
    expect(await snapshot(second.appointmentId)).toMatchObject({
      firstName: "Lea M",
      lastName: "Martin",
      email: "lea@x.test",
      phone: "0612345678",
    });
    expect(await snapshot(third.appointmentId)).toMatchObject({
      firstName: "Impostor",
      lastName: "Other",
      phone: "0000000000",
    });
  });

  it("the public answer is the same shape whether the customer existed or not, and reveals no customer", async () => {
    const created = await publicBooking({ time: "09:00", email: "new@x.test" });
    const reused = await publicBooking({ time: "10:00", email: "new@x.test" });
    expect(Object.keys(reused).sort()).toEqual(Object.keys(created).sort());
    const text = JSON.stringify([created, reused]);
    const [customer] = await customers();
    expect(text).not.toContain(customer!.id);
    expect(text).not.toContain("new@x.test");
  });

  it("an existing complete customer is not rewritten (updated_at unchanged)", async () => {
    await publicBooking({
      time: "09:00",
      email: "full@x.test",
      lastName: "Martin",
      phone: "0612345678",
    });
    const before = await db.query(
      "select updated_at from public.clients where business_id = $1",
      [business.id],
    );
    await publicBooking({
      time: "10:00",
      email: "full@x.test",
      phone: "0700000000",
    });
    const after = await db.query(
      "select updated_at, phone from public.clients where business_id = $1",
      [business.id],
    );
    expect(after.rows[0]).toEqual({
      updated_at: before.rows[0].updated_at,
      phone: "0612345678",
    });
  });

  it("manual creation resolves with the same rule: an email of an existing customer reuses it", async () => {
    await publicBooking({ time: "09:00", email: "lea@x.test" });
    const manual = await manualCreation(owner, business.id, service, "10:00", {
      p_client_first_name: "Léa",
      p_client_email: "  LEA@X.TEST ",
      p_client_phone: "0612345678",
    });
    expect(await customers()).toMatchObject([
      { email: "lea@x.test", phone: "0612345678", appointments: 2 },
    ]);
    expect(await snapshot(manual)).toMatchObject({
      firstName: "Léa",
      email: "lea@x.test",
      phone: "0612345678",
    });
  });
});

describe("customers without email", () => {
  it("a manual appointment without email is a new customer each time, never matched by name or phone", async () => {
    const one = await manualCreation(owner, business.id, service, "09:00", {
      p_client_first_name: "Léa",
      p_client_phone: "0612345678",
    });
    const two = await manualCreation(owner, business.id, service, "10:00", {
      p_client_first_name: "Léa",
      p_client_email: "   ",
      p_client_phone: "0612345678",
    });
    const rows = await customers();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.email)).toEqual([null, null]);
    expect((await snapshot(one)).email).toBeNull();
    expect((await snapshot(two)).email).toBeNull();
  });

  it("an existing customer chosen by id: the appointment's snapshot is that record's contact", async () => {
    const id = await createClientRecord(business.id, "chosen@x.test", "Inès");
    const appointment = await manualCreation(
      owner,
      business.id,
      service,
      "09:00",
      {
        p_client_id: id,
      },
    );
    expect(await snapshot(appointment)).toMatchObject({
      client_id: id,
      firstName: "Inès",
      email: "chosen@x.test",
    });
  });
});

describe("contact snapshots are history", () => {
  it("a later change of the customer record never changes an appointment's snapshot", async () => {
    const appointment = await rawPublicBooking("09:00", "lea@x.test", "Léa");
    await db.query(
      `update public.clients
       set first_name = 'Léa-Marie', last_name = 'Martin', email = 'new@x.test', phone = '0612345678'
       where business_id = $1`,
      [business.id],
    );
    expect(await snapshot(appointment)).toMatchObject({
      firstName: "Léa",
      lastName: null,
      email: "lea@x.test",
      phone: null,
    });
  });

  it("a snapshot cannot be rewritten while the appointment stays with its customer", async () => {
    const appointment = await rawPublicBooking("09:00", "lea@x.test", "Léa");
    await expect(
      db.query(
        "update public.appointments set client_first_name_snapshot = 'X' where id = $1",
        [appointment],
      ),
    ).rejects.toMatchObject({ message: "contact_snapshot_immutable" });
    // Other edits go on as before.
    await db.query(
      "update public.appointments set internal_notes = 'x' where id = $1",
      [appointment],
    );
  });

  it("moved to another customer by a professional, the appointment takes that customer's contact", async () => {
    const appointment = await rawPublicBooking("09:00", "lea@x.test", "Léa");
    const other = await createClientRecord(business.id, "ines@x.test", "Inès");
    const { error } = await owner.client.rpc("agenda_update_appointment", {
      p_business_id: business.id,
      p_appointment_id: appointment,
      p_expected_version: 1,
      p_service_id: service,
      p_client_id: other,
    });
    expect(error).toBeNull();
    expect(await snapshot(appointment)).toMatchObject({
      client_id: other,
      firstName: "Inès",
      email: "ines@x.test",
    });
  });
});

describe("concurrency", () => {
  it("simultaneous bookings with one email on different slots: one customer, every appointment linked to it", async () => {
    const times = [
      "08:00",
      "08:30",
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ];
    const results = await Promise.all(
      times.map((time, index) =>
        publicBooking({
          time,
          email: index % 2 === 0 ? "rush@x.test" : "  RUSH@X.test ",
          firstName: `Léa ${index}`,
          phone: index === 5 ? "0612345678" : undefined,
        }),
      ),
    );
    expect(results).toHaveLength(times.length);
    expect(await customers()).toMatchObject([
      { email: "rush@x.test", phone: "0612345678", appointments: times.length },
    ]);
  });

  it("simultaneous bookings with one email in two businesses: one customer in each", async () => {
    const other = await newBusiness(owner);
    await Promise.all(
      ["09:00", "10:00", "11:00"].flatMap((time) => [
        publicBooking({ time, email: "both@x.test" }),
        publicBooking({ time, email: "BOTH@x.test" }, other),
      ]),
    );
    expect(await customers()).toMatchObject([{ appointments: 3 }]);
    expect(await customers(other.business.id)).toMatchObject([
      { appointments: 3 },
    ]);
  });

  it("same slot, same email: exactly one booking commits, one customer", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        publicBooking({ time: "09:00", email: "same-slot@x.test" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await customers()).toMatchObject([{ appointments: 1 }]);
  });

  it("lock order: a member editing the customer and a booking resolving it wait for each other, never deadlock", async () => {
    const id = await createClientRecord(business.id, "lock@x.test", "Léa");

    // 1. The member's edit holds the customer row; the booking (schedule
    //    lock taken) waits for it, then reuses the customer.
    const edit = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });
    await edit.connection.query(
      "update public.clients set first_name = 'Léa-Marie', phone = '0612345678' where id = $1",
      [id],
    );
    const booking = await openTransaction();
    const pending = outcome(
      booking.connection.query(
        `select private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Léa', 'lock@x.test', null, '0700000000')`,
        [business.slug, service, at("09:00")],
      ),
    );
    await waitUntilBlocked(booking.pid);
    await closeTransaction(edit, "commit");
    expect(await pending).toBe("ok");
    await closeTransaction(booking, "commit");

    // 2. The booking holds the schedule lock and the customer row; the
    //    member's edit waits, then applies.
    const second = await openTransaction();
    await second.connection.query(
      `select private.create_public_booking_at(now(), $1, $2, $3::timestamptz, 'Léa', 'lock@x.test', 'Martin')`,
      [business.slug, service, at("10:00")],
    );
    const rename = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });
    const renamed = outcome(
      rename.connection.query(
        "update public.clients set first_name = 'Léa' where id = $1",
        [id],
      ),
    );
    await waitUntilBlocked(rename.pid);
    await closeTransaction(second, "commit");
    expect(await renamed).toBe("ok");
    await closeTransaction(rename, "commit");

    expect(await customers()).toMatchObject([
      {
        id,
        first_name: "Léa",
        last_name: "Martin",
        phone: "0612345678",
        appointments: 2,
      },
    ]);
  });
});

describe("tenant isolation (RLS) and API surface", () => {
  it("members read and write only their business's customers; anon reads none", async () => {
    const stranger = await createProfessional("crm-stranger");
    const theirs = await newBusiness(stranger);
    const mine = await createClientRecord(business.id, "mine@x.test");
    const foreign = await createClientRecord(
      theirs.business.id,
      "foreign@x.test",
    );

    const member = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });
    try {
      const { rows } = await member.connection.query(
        "select id from public.clients where id = any($1)",
        [[mine, foreign]],
      );
      expect(rows).toEqual([{ id: mine }]);
      const updated = await member.connection.query(
        "update public.clients set first_name = 'X' where id = $1",
        [foreign],
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await member.connection.query(
        "delete from public.clients where id = $1",
        [foreign],
      );
      expect(deleted.rowCount).toBe(0);
      await expect(
        member.connection.query(
          "insert into public.clients (business_id, first_name, email) values ($1, 'X', 'x@x.test')",
          [theirs.business.id],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await closeTransaction(member, "rollback");
    }

    const { data, error } = await anon.from("clients").select("id").limit(1);
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: "42501" });
    for (const statement of [
      "select id from public.clients limit 1",
      "insert into public.clients (business_id, first_name, email) values ('" +
        business.id +
        "', 'X', 'anon@x.test')",
    ]) {
      const visitor = await openTransaction({ role: "anon" });
      await expect(visitor.connection.query(statement)).rejects.toMatchObject({
        code: "42501",
      });
      await closeTransaction(visitor, "rollback");
    }
  });

  it("the resolver and the normalization are not reachable from the API", async () => {
    const { rows } = await db.query(
      `select r.rolname as role,
              has_function_privilege(r.rolname, 'private.resolve_client(uuid, text, text, text, text)', 'execute') as resolve,
              has_function_privilege(r.rolname, 'private.canonical_email(text)', 'execute') as canonical,
              has_schema_privilege(r.rolname, 'private', 'usage') as schema
       from pg_roles r where r.rolname in ('anon', 'authenticated') order by 1`,
    );
    expect(rows).toEqual([
      { role: "anon", resolve: false, canonical: false, schema: false },
      {
        role: "authenticated",
        resolve: false,
        canonical: false,
        schema: false,
      },
    ]);
    const { error } = await anon.rpc("resolve_client" as never, {} as never);
    expect(error).not.toBeNull();
  });

  it("customers are never Auth users: no link to auth.users from clients", async () => {
    const { rows } = await db.query(
      `select confrelid::regclass::text as target
       from pg_constraint where conrelid = 'public.clients'::regclass and contype = 'f'`,
    );
    expect(rows).toEqual([{ target: "businesses" }]);
    const before = await db.query("select count(*)::int as n from auth.users");
    await publicBooking({ time: "09:00", email: `${randomUUID()}@x.test` });
    const after = await db.query("select count(*)::int as n from auth.users");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("performance", () => {
  it("resolution by email is an index lookup on (business_id, email)", async () => {
    await db.query(
      `insert into public.clients (business_id, first_name, email)
       select $1, 'C', 'c' || g || '@x.test' from generate_series(1, 5000) g`,
      [business.id],
    );
    await db.query("analyze public.clients");
    const { rows } = await db.query<{ "QUERY PLAN": string }>(
      `explain select c.id from public.clients c
       where c.business_id = $1 and c.email operator(extensions.=) 'c42@x.test'::extensions.citext`,
      [business.id],
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(
      /Index (Only )?Scan using clients_business_id_email_key/,
    );
    expect(plan).not.toMatch(/Seq Scan/);
  });
});

describe("appointments inserted by other paths", () => {
  it("get the linked customer's contact as snapshot", async () => {
    const id = await createClientRecord(business.id, "arranged@x.test", "Nora");
    const appointment = await insertAppointment({
      businessId: business.id,
      clientId: id,
      serviceId: service,
      startsAt: at("09:00"),
      endsAt: at("09:30"),
    });
    expect(await snapshot(appointment)).toMatchObject({
      firstName: "Nora",
      email: "arranged@x.test",
    });
  });
});
