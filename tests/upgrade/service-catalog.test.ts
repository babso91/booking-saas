import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  everyDay,
  insertAppointment,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade from member preferences (20261031090000) to the catalogue with a
// populated database: services, appointments and an idempotent public
// booking made before. Nothing existing is rewritten, slots are the same,
// and a retry of a booking made before the upgrade is answered, not
// booked twice nor refused.

const BEFORE = "20261031090000";
const NOW = "2027-01-04T08:00:00Z";
const DAY = "2027-01-12";

let owner: Professional;
let business: TestBusiness;
let serviceId: string;
let requestId: string;
let booked: string;
let manual: string;
let beforeRows: string;
let beforeSlots: string[];

const OLD_COLUMNS = `
  id, business_id, client_id, service_id, starts_at, ends_at, status,
  service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot,
  currency, buffer_minutes_snapshot, occupied_window, version,
  creation_request_id, creation_request_fingerprint`;

async function rows() {
  const { rows } = await db.query(
    `select md5(concat_ws('#',
       (select string_agg(concat_ws(',', s.id, s.name, s.description, s.duration_minutes,
          s.price_cents, s.active, s.display_order, s.version), '|' order by s.id)
        from public.services s where s.business_id = $1),
       (select string_agg(a::text, '|' order by a.id)
        from (select ${OLD_COLUMNS} from public.appointments where business_id = $1) a)
     )) as hash`,
    [business.id],
  );
  return rows[0].hash as string;
}

async function slots() {
  const { rows } = await db.query<{ starts_at: Date }>(
    `select starts_at from private.available_slots($1, $2, $3::date, $4::timestamptz)`,
    [business.id, serviceId, DAY, NOW],
  );
  return rows.map((row) => row.starts_at.toISOString());
}

const booking = (id: string) =>
  db.query<{ appointment_id: string; replayed: boolean }>(
    `select appointment_id, replayed
     from private.create_public_booking_at($1::timestamptz, $2, $3::uuid,
       $4::timestamptz, 'Léa', 'lea@test.local', null, null, $5::uuid, null)`,
    [NOW, business.slug, serviceId, "2027-01-12T09:00:00Z", id],
  );

describe("upgrade to the catalogue", () => {
  beforeAll(async () => {
    resetTo(BEFORE);
    owner = await createProfessional("catalog-upgrade");
    business = await createBusiness(owner.userId, {
      settings: {
        maximum_booking_advance_days: 365,
        slot_interval_minutes: 30,
        buffer_minutes: 10,
      },
    });
    await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
    serviceId = await createService(business.id, {
      durationMinutes: 75,
      priceCents: 6500,
    });
    await createService(business.id, { name: "Inactive", active: false });

    requestId = randomUUID();
    booked = (await booking(requestId)).rows[0]!.appointment_id;
    const clientId = await createClientRecord(business.id, "manual@test.local");
    manual = await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId,
      startsAt: "2027-01-12T13:00:00Z",
      endsAt: "2027-01-12T14:15:00Z",
      bufferMinutes: 10,
    });

    beforeRows = await rows();
    beforeSlots = await slots();
    migrateUp();
  });

  it("rewrites no service and no appointment", async () => {
    expect(await rows()).toBe(beforeRows);
    const { rows: added } = await db.query(
      `select
         (select bool_and(category_id is null and options_revision = 0)
          from public.services where business_id = $1) as services,
         (select bool_and(options_snapshot = '[]'::jsonb)
          from public.appointments where id in ($2, $3)) as appointments,
         (select count(*)::int from public.service_categories where business_id = $1) as categories,
         (select count(*)::int from public.service_options where business_id = $1) as options`,
      [business.id, booked, manual],
    );
    expect(added[0]).toEqual({
      services: true,
      appointments: true,
      categories: 0,
      options: 0,
    });
  });

  it("offers the same slots for a service without options", async () => {
    expect(await slots()).toEqual(beforeSlots);
  });

  it("answers a retry of a booking made before the upgrade", async () => {
    const { rows: retried } = await booking(requestId);
    expect(retried[0]).toEqual({ appointment_id: booked, replayed: true });
    const { rows: count } = await db.query(
      "select count(*)::int as n from public.appointments where business_id = $1",
      [business.id],
    );
    expect(count[0].n).toBe(2);
  });

  it("then lets her organise and price the same services", async () => {
    const { data: category, error } = await owner.client
      .rpc("create_service_category", {
        p_business_id: business.id,
        p_request_id: randomUUID(),
        p_name: "Regard",
      })
      .single();
    expect(error).toBeNull();
    const { data: service } = await owner.client
      .from("services")
      .update({ category_id: category!.category_id })
      .eq("id", serviceId)
      .select("version")
      .single();
    const { error: optionsError } = await owner.client.rpc(
      "set_service_options",
      {
        p_business_id: business.id,
        p_service_id: serviceId,
        p_expected_version: service!.version,
        p_options: [
          {
            question: "Dépose ?",
            required: false,
            choices: [
              { label: "Oui", priceDeltaCents: 1000, durationDeltaMinutes: 15 },
            ],
          },
        ],
      },
    );
    expect(optionsError).toBeNull();
    // The appointments made before keep what was agreed.
    expect(await rows()).not.toBe(beforeRows); // the service changed…
    const { rows: kept } = await db.query(
      `select price_cents_snapshot, duration_minutes_snapshot, options_snapshot
       from public.appointments where id = $1`,
      [booked],
    );
    expect(kept[0]).toEqual({
      price_cents_snapshot: 6500,
      duration_minutes_snapshot: 75,
      options_snapshot: [],
    });
  });
});
