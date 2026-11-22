import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getNextSlots } from "@/app/api/public/businesses/[slug]/next-slots/route";

import {
  addException,
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  env,
  everyDay,
  insertAppointment,
  setWeeklyHours,
  type TestBusiness,
} from "./support/fixtures";

// Higani point 2: « Prochaine disponibilité » on the mini-site. One read
// gives the next bookable slot of every service bookable online, from the
// very engine of the booking page (contract agreed with Claude UI).

const TZ = "Europe/Paris";
type Row = {
  service_id: string;
  local_starts_at: string | null;
  local_ends_at: string | null;
};

let business: TestBusiness;
let short: string;
let long: string;
/** Two days ahead, in the business's calendar. */
let day: string;

/** `HH:MM` of `date` in Paris, as an instant (ISO). */
async function at(date: string, time: string) {
  const { rows } = await db.query<{ instant: string }>(
    "select (($1::date + $2::time) at time zone $3)::text as instant",
    [date, time, TZ],
  );
  return rows[0]!.instant;
}

/** `date` + `days`, as `YYYY-MM-DD`. */
async function plus(date: string, days: number) {
  const { rows } = await db.query<{ day: string }>(
    "select ($1::date + $2::int)::text as day",
    [date, days],
  );
  return rows[0]!.day;
}

async function nextSlots(slug = business.slug) {
  const { rows } = await db.query<Row>(
    "select service_id, local_starts_at, local_ends_at from public.get_public_next_slots($1)",
    [slug],
  );
  return rows;
}
const of = (rows: Row[], id: string) =>
  rows.find((row) => row.service_id === id);

beforeAll(() => {
  // The public route reads Supabase as the booking page does.
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
});

beforeEach(async () => {
  const owner = await createProfessional("next-slots");
  business = await createBusiness(owner.userId, {
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 0,
      maximum_booking_advance_days: 30,
    },
  });
  await setWeeklyHours(business.id, everyDay(["09:00", "12:00"]));
  short = await createService(business.id, {
    name: "Court",
    durationMinutes: 60,
  });
  long = await createService(business.id, {
    name: "Long",
    durationMinutes: 120,
  });
  const { rows } = await db.query<{ day: string }>(
    "select ((now() at time zone $1)::date + 2)::text as day",
    [TZ],
  );
  day = rows[0]!.day;
  // Closed until that day: whatever the hour of the run, it holds the
  // first slots.
  await addException(
    business.id,
    "closed",
    new Date(Date.now() - 3_600_000).toISOString(),
    await at(day, "00:00"),
  );
});

describe("point 2: the next bookable slot of each service", () => {
  it("is the first slot the booking page offers for that service", async () => {
    const rows = await nextSlots();
    expect(of(rows, short)).toMatchObject({
      local_starts_at: `${day}T09:00`,
      local_ends_at: `${day}T10:00`,
    });
    expect(of(rows, long)).toMatchObject({
      local_starts_at: `${day}T09:00`,
      local_ends_at: `${day}T11:00`,
    });
    for (const service of [short, long]) {
      const { rows: offered } = await db.query<{ local_starts_at: string }>(
        "select local_starts_at from public.get_available_slots($1, $2, $3) limit 1",
        [business.slug, service, day],
      );
      expect(of(rows, service)?.local_starts_at).toBe(
        offered[0]!.local_starts_at,
      );
    }
  });

  it("follows appointments and blocks, each service by its own length", async () => {
    const client = await createClientRecord(business.id, "a@client.test");
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: short,
      startsAt: await at(day, "09:00"),
      endsAt: await at(day, "10:00"),
    });
    let rows = await nextSlots();
    expect(of(rows, short)?.local_starts_at).toBe(`${day}T10:00`);
    expect(of(rows, long)?.local_starts_at).toBe(`${day}T10:00`);

    await addException(
      business.id,
      "blocked",
      await at(day, "11:00"),
      await at(day, "12:00"),
    );
    rows = await nextSlots();
    expect(of(rows, short)?.local_starts_at).toBe(`${day}T10:00`);
    // Two hours no longer fit that day: the next morning.
    expect(of(rows, long)?.local_starts_at).toBe(`${await plus(day, 1)}T09:00`);
    // Earliest first.
    expect(rows.map((row) => row.service_id)).toEqual([short, long]);
  });

  it("follows the hours of a date, with several ranges", async () => {
    await db.query(
      `insert into public.business_date_hours (business_id, date, starts_at, ends_at)
       values ($1, $2, '14:00', '15:00'), ($1, $2, '16:00', '18:00')`,
      [business.id, day],
    );
    const rows = await nextSlots();
    expect(of(rows, short)?.local_starts_at).toBe(`${day}T14:00`);
    expect(of(rows, long)?.local_starts_at).toBe(`${day}T16:00`);
  });

  it("follows the minimum notice", async () => {
    await db.query(
      "update public.business_settings set minimum_booking_notice_minutes = 4320 where business_id = $1",
      [business.id],
    );
    const { rows } = await db.query<{ starts_at: Date }>(
      "select starts_at from public.get_public_next_slots($1) where service_id = $2",
      [business.slug, short],
    );
    expect(rows[0]!.starts_at.getTime()).toBeGreaterThanOrEqual(
      Date.now() + 3 * 86_400_000 - 60_000,
    );
  });

  it("quotes a required option with the answer the booking page preselects", async () => {
    // First answer (preselected): +60 min. A shorter one comes second.
    const { rows: option } = await db.query<{ id: string }>(
      `insert into public.service_options (business_id, service_id, question, required, display_order)
       values ($1, $2, 'Longueur', true, 0) returning id`,
      [business.id, short],
    );
    await db.query(
      `insert into public.service_option_choices
         (business_id, option_id, label, price_delta_cents, duration_delta_minutes, display_order)
       values ($1, $2, 'Volume', 1500, 60, 0), ($1, $2, 'Naturelle', 0, 0, 1)`,
      [business.id, option[0]!.id],
    );
    const client = await createClientRecord(business.id, "b@client.test");
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: long,
      startsAt: await at(day, "10:00"),
      endsAt: await at(day, "11:00"),
    });
    // Two hours do not fit around 10:00–11:00: the next morning.
    const next = await plus(day, 1);
    expect(of(await nextSlots(), short)).toMatchObject({
      local_starts_at: `${next}T09:00`,
      local_ends_at: `${next}T11:00`,
    });
  });

  it("lists every service bookable online, with no slot when none can be booked", async () => {
    const hidden = await createService(business.id, { name: "Inactive" });
    await db.query("update public.services set active = false where id = $1", [
      hidden,
    ]);
    // A required question without any answer: never bookable online.
    const broken = await createService(business.id, { name: "Sans réponse" });
    await db.query(
      `insert into public.service_options (business_id, service_id, question, required, display_order)
       values ($1, $2, 'Question', true, 0)`,
      [business.id, broken],
    );
    const rows = await nextSlots();
    expect(rows.map((row) => row.service_id).sort()).toEqual(
      [short, long, broken].sort(),
    );
    expect(of(rows, broken)).toMatchObject({
      local_starts_at: null,
      local_ends_at: null,
    });
    // Last: services without a slot come after the others.
    expect(rows.at(-1)?.service_id).toBe(broken);
  });

  it("gives no slot beyond the booking horizon", async () => {
    await db.query(
      "update public.business_settings set maximum_booking_advance_days = 5 where business_id = $1",
      [business.id],
    );
    // Closed from that day until well beyond the 5 days.
    await addException(
      business.id,
      "closed",
      await at(day, "00:00"),
      await at(await plus(day, 10), "00:00"),
    );
    const rows = await nextSlots();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.local_starts_at === null)).toBe(true);
  });
});

describe("point 2: the public read", () => {
  const read = (slug: string) =>
    getNextSlots(
      new NextRequest(
        `http://localhost/api/public/businesses/${slug}/next-slots`,
      ),
      { params: Promise.resolve({ slug }) },
    );

  it("answers anyone with service ids and public slot times only, earliest first", async () => {
    const response = await read(business.slug);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { services: { serviceId: string; slot: object | null }[] };
    };
    expect(body.data.services[0]).toEqual({
      serviceId: expect.any(String),
      slot: {
        startsAt: expect.any(String),
        endsAt: expect.any(String),
        localStartsAt: `${day}T09:00`,
        localEndsAt: expect.any(String),
      },
    });
    const anonymous = await anonClient().rpc("get_public_next_slots", {
      p_slug: business.slug,
    });
    expect(anonymous.error).toBeNull();
    expect(anonymous.data).toHaveLength(2);
  });

  it("never lists another business's services; an unknown business is not found", async () => {
    const other = await createProfessional("next-slots-other");
    const elsewhere = await createBusiness(other.userId);
    await createService(elsewhere.id, { name: "Ailleurs" });
    const rows = await nextSlots();
    expect(rows.map((row) => row.service_id).sort()).toEqual(
      [short, long].sort(),
    );
    const missing = await read("nobody-here-0000");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "business_not_found" },
    });
  });
});
