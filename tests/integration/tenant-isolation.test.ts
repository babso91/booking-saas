import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Business A / business B, each with its own professional. Every assertion
// goes through PostgREST with a real Supabase Auth session, i.e. exactly the
// path a malicious user would take, and relies on PostgreSQL alone (RLS,
// grants, composite foreign keys). User A knows every UUID of business B.

let userA: Professional;
let userB: Professional;
let businessA: TestBusiness;
let businessB: TestBusiness;
let serviceA: string;
let serviceB: string;
let clientB: string;
let appointmentB: string;
let hourB: string;
let exceptionB: string;

beforeAll(async () => {
  [userA, userB] = await Promise.all([
    createProfessional("tenant-a"),
    createProfessional("tenant-b"),
  ]);
  businessA = await createBusiness(userA.userId);
  businessB = await createBusiness(userB.userId);
  serviceA = await createService(businessA.id, { name: "Service A" });
  serviceB = await createService(businessB.id, { name: "Service B" });
  clientB = await createClientRecord(businessB.id, "secret-b@example.test");
  appointmentB = await insertAppointment({
    businessId: businessB.id,
    clientId: clientB,
    serviceId: serviceB,
    startsAt: "2031-03-03T10:00:00Z",
    endsAt: "2031-03-03T11:00:00Z",
  });

  const hour = await db.query<{ id: string }>(
    `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
     values ($1, 1, '09:00', '18:00') returning id`,
    [businessB.id],
  );
  hourB = hour.rows[0]!.id;
  const exception = await db.query<{ id: string }>(
    `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
     values ($1, 'blocked', '2031-03-04T10:00Z', '2031-03-04T12:00Z') returning id`,
    [businessB.id],
  );
  exceptionB = exception.rows[0]!.id;
});

describe("reads across tenants", () => {
  it("user A sees their own business data", async () => {
    const services = await userA.client.from("services").select("id");
    const businesses = await userA.client.from("businesses").select("id");

    expect(services.data?.map((row) => row.id)).toEqual([serviceA]);
    expect(businesses.data?.map((row) => row.id)).toEqual([businessA.id]);
  });

  it.each([
    ["businesses", "id", () => businessB.id],
    ["business_members", "business_id", () => businessB.id],
    ["business_settings", "business_id", () => businessB.id],
    ["services", "id", () => serviceB],
    ["business_hours", "id", () => hourB],
    ["availability_exceptions", "id", () => exceptionB],
    ["clients", "id", () => clientB],
    ["appointments", "id", () => appointmentB],
    ["email_events", "business_id", () => businessB.id],
  ] as const)(
    "user A cannot read %s of business B, even by UUID",
    async (table, column, id) => {
      // Table names vary per case: use the schema-agnostic client type.
      const client = userA.client as unknown as SupabaseClient;

      const byId = await client.from(table).select("*").eq(column, id());
      const byBusiness = await client
        .from(table)
        .select("*")
        .eq(table === "businesses" ? "id" : "business_id", businessB.id);

      expect(byId.error).toBeNull();
      expect(byId.data).toEqual([]);
      expect(byBusiness.error).toBeNull();
      expect(byBusiness.data).toEqual([]);
    },
  );

  it("an anonymous caller cannot read any table directly", async () => {
    const anon = anonClient();

    for (const table of [
      "services",
      "clients",
      "appointments",
      "businesses",
    ] as const) {
      const { data, error } = await anon.from(table).select("id");

      // Either denied outright (no privilege) or an empty result.
      expect(data ?? []).toEqual([]);
      expect(error?.code ?? "42501").toBe("42501");
    }
  });
});

describe("writes across tenants", () => {
  it("user A cannot update a service of business B by UUID", async () => {
    const { data, error } = await userA.client
      .from("services")
      .update({ name: "hacked", price_cents: 1 })
      .eq("id", serviceB)
      .select();

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { rows } = await db.query(
      "select name, price_cents from public.services where id = $1",
      [serviceB],
    );
    expect(rows[0]).toEqual({ name: "Service B", price_cents: 6500 });
  });

  it("user A cannot delete data of business B by UUID", async () => {
    await userA.client.from("services").delete().eq("id", serviceB);
    await userA.client.from("clients").delete().eq("id", clientB);
    await userA.client.from("business_hours").delete().eq("id", hourB);
    await userA.client
      .from("availability_exceptions")
      .delete()
      .eq("id", exceptionB);

    const { rows } = await db.query(
      `select
         (select count(*)::int from public.services where id = $1) as services,
         (select count(*)::int from public.clients where id = $2) as clients,
         (select count(*)::int from public.business_hours where id = $3) as hours,
         (select count(*)::int from public.availability_exceptions where id = $4) as exceptions`,
      [serviceB, clientB, hourB, exceptionB],
    );
    expect(rows[0]).toEqual({
      services: 1,
      clients: 1,
      hours: 1,
      exceptions: 1,
    });
  });

  it("user A cannot insert rows into business B", async () => {
    const service = await userA.client
      .from("services")
      .insert({
        business_id: businessB.id,
        name: "Intrus",
        duration_minutes: 30,
        price_cents: 100,
      })
      .select();
    const client = await userA.client
      .from("clients")
      .insert({ business_id: businessB.id, first_name: "X", email: "x@x.fr" })
      .select();
    const exception = await userA.client
      .from("availability_exceptions")
      .insert({
        business_id: businessB.id,
        kind: "closed",
        starts_at: "2031-01-01T00:00Z",
        ends_at: "2031-01-02T00:00Z",
      })
      .select();

    for (const result of [service, client, exception]) {
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("42501");
    }
  });

  it("user A cannot move their own row into business B", async () => {
    const { error } = await userA.client
      .from("services")
      .update({ business_id: businessB.id })
      .eq("id", serviceA);

    expect(error?.code).toBe("42501");
  });

  it("user A cannot join business B as a member", async () => {
    const { error } = await userA.client.from("business_members").insert({
      business_id: businessB.id,
      user_id: userA.userId,
      role: "owner",
    });

    expect(error?.code).toBe("42501");
  });

  it("user A cannot change settings or business profile of B", async () => {
    await userA.client
      .from("business_settings")
      .update({ buffer_minutes: 120 })
      .eq("business_id", businessB.id);
    await userA.client
      .from("businesses")
      .update({ name: "hacked" })
      .eq("id", businessB.id);

    const { rows } = await db.query(
      `select b.name, s.buffer_minutes from public.businesses b
       join public.business_settings s on s.business_id = b.id where b.id = $1`,
      [businessB.id],
    );
    expect(rows[0]).toEqual({
      name: `Studio ${businessB.slug}`,
      buffer_minutes: 0,
    });
  });

  it("appointments cannot be written directly, even in one's own business", async () => {
    const insert = await userA.client.from("appointments").insert({
      business_id: businessA.id,
      client_id: clientB,
      service_id: serviceA,
      starts_at: "2031-03-03T10:00:00Z",
      ends_at: "2031-03-03T11:00:00Z",
      service_name_snapshot: "x",
      duration_minutes_snapshot: 60,
      price_cents_snapshot: 0,
      occupied_window: null,
    });
    const update = await userA.client
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointmentB)
      .select();

    expect(insert.error?.code).toBe("42501");
    expect(update.data ?? []).toEqual([]);

    const { rows } = await db.query(
      "select status from public.appointments where id = $1",
      [appointmentB],
    );
    expect(rows[0]).toEqual({ status: "confirmed" });
  });

  it("RPCs of user A refuse to act on business B", async () => {
    const hours = await userA.client.rpc("replace_business_hours", {
      p_business_id: businessB.id,
      p_hours: [],
    });
    const reorder = await userA.client.rpc("reorder_services", {
      p_business_id: businessB.id,
      p_service_ids: [serviceB],
    });

    expect(hours.error?.message).toBe("forbidden");
    expect(reorder.error?.message).toBe("forbidden");

    const { rows } = await db.query(
      "select count(*)::int as count from public.business_hours where business_id = $1",
      [businessB.id],
    );
    expect(rows[0]).toEqual({ count: 1 });
  });
});

describe("composite foreign keys", () => {
  it("reject an appointment linking a client of another business", async () => {
    await expect(
      insertAppointment({
        businessId: businessA.id,
        clientId: clientB,
        serviceId: serviceA,
        startsAt: "2031-05-05T10:00:00Z",
        endsAt: "2031-05-05T11:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("reject an appointment using a service of another business", async () => {
    const clientA = await createClientRecord(businessA.id, "fk@example.test");

    await expect(
      db.query(
        `insert into public.appointments (
           business_id, client_id, service_id, starts_at, ends_at,
           service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot
         ) values ($1, $2, $3, '2031-05-06T10:00Z', '2031-05-06T11:00Z', 'x', 60, 0)`,
        [businessA.id, clientA, serviceB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
