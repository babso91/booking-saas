import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as postBooking } from "@/app/api/bookings/route";
import { GET as getAvailability } from "@/app/api/public/businesses/[slug]/availability/route";
import {
  listBusinessHours,
  replaceBusinessHours,
} from "@/features/availability/data/schedule";

import {
  createBusiness,
  createProfessional,
  createService,
  db,
  env,
  randomIp,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Point 218 (Higani backlog): the days she allows bookings on. She sets them
// where she sets her week: a day without hours is closed to online booking,
// one date can still open exceptionally, and the public calendar and the
// booking route tell the same story. Her own agenda stays open to her.
//
// Case: Europe/Paris, slots every 30 min, notice 60 min, horizon 28 days,
// « Coupe » 60 min; open 09:00–12:00 every day but Wednesday and Sunday.

const SECRET = "booking-days-test-proxy-secret-0123456789ab";
const BASE = "http://localhost:3000";
const TZ = "Europe/Paris";
const CLOSED = [0, 3]; // Sunday, Wednesday
const WEEK = [1, 2, 4, 5, 6].map((weekday) => ({
  weekday,
  startsAt: "09:00",
  endsAt: "12:00",
}));

type Slot = { startsAt: string; localStartsAt: string };

let owner: Professional;
let business: TestBusiness;
let service: string;

const localDate = (daysFromToday: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(Date.now() + daysFromToday * 86_400_000),
  );
/** 0 = Sunday, of a local calendar date. */
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** The first date from today + `after` days falling on `weekday`. */
function next(weekday: number, after = 2) {
  for (let day = after; day < after + 7; day += 1) {
    if (weekdayOf(localDate(day)) === weekday) return localDate(day);
  }
  throw new Error("unreachable");
}
const plusDays = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** A local wall clock of the business, as the instant the client sends. */
async function instant(date: string, time: string) {
  const { rows } = await db.query<{ at: Date }>(
    "select ($1::date + $2::time) at time zone $3 as at",
    [date, time, TZ],
  );
  return rows[0]!.at.toISOString();
}

function request(method: string, path: string, body?: unknown) {
  return new NextRequest(new URL(path, BASE), {
    method,
    headers: new Headers({
      "content-type": "application/json",
      origin: BASE,
      "x-booking-proxy-secret": SECRET,
      "x-booking-client-ip": randomIp(),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function calendar(from: string, through: string) {
  const query = new URLSearchParams({
    serviceId: service,
    date: from,
    through,
  });
  const response = await getAvailability(
    request(
      "GET",
      `/api/public/businesses/${business.slug}/availability?${query}`,
    ),
    { params: Promise.resolve({ slug: business.slug }) },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.data.days as { date: string; slots: Slot[] }[];
}
const times = (slots: Slot[]) =>
  slots.map((slot) => slot.localStartsAt.slice(11, 16));

async function book(startsAt: string) {
  const response = await postBooking(
    request("POST", "/api/bookings", {
      slug: business.slug,
      serviceId: service,
      startsAt,
      firstName: "Lou",
      email: `lou-${randomUUID().slice(0, 8)}@client.test`,
      requestId: randomUUID(),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const appointmentsOn = async (date: string) =>
  (
    await db.query(
      `select id from public.appointments
       where business_id = $1 and status <> 'cancelled'
         and (starts_at at time zone $2)::date = $3::date`,
      [business.id, TZ, date],
    )
  ).rowCount;

/** As her schedule editor saves the week: the whole week, from the one read. */
async function saveWeek(hours: typeof WEEK) {
  const current = await listBusinessHours(owner.client, business.id);
  return replaceBusinessHours(owner.client, business.id, {
    hours,
    expected: current.map(({ weekday, startsAt, endsAt }) => ({
      weekday,
      startsAt,
      endsAt,
    })),
  });
}

beforeAll(async () => {
  process.env.BOOKING_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;

  owner = await createProfessional("booking-days");
  business = await createBusiness(owner.userId, {
    timezone: TZ,
    settings: {
      slot_interval_minutes: 30,
      buffer_minutes: 0,
      minimum_booking_notice_minutes: 60,
      maximum_booking_advance_days: 28,
    },
  });
  service = await createService(business.id, {
    name: "Coupe",
    durationMinutes: 60,
  });
  const saved = await saveWeek(WEEK);
  expect(saved.map((range) => range.weekday).sort()).toEqual([1, 2, 4, 5, 6]);
});

describe("point 218: the days she allows bookings on", () => {
  it("the public calendar offers her open days only, over two weeks", async () => {
    const from = localDate(2);
    const days = await calendar(from, plusDays(from, 13));
    expect(days).toHaveLength(14);
    for (const day of days) {
      if (CLOSED.includes(weekdayOf(day.date))) {
        expect(day.slots, day.date).toEqual([]);
      } else {
        expect(times(day.slots), day.date).toEqual([
          "09:00",
          "09:30",
          "10:00",
          "10:30",
          "11:00",
        ]);
      }
    }
  });

  it("a booking sent for a closed day is refused, even within usual hours", async () => {
    for (const date of [next(3), next(0)]) {
      const refused = await book(await instant(date, "10:00"));
      expect(refused.status, date).toBe(409);
      expect(refused.body.error.code).toBe("slot_unavailable");
      expect(await appointmentsOn(date)).toBe(0);
    }
  });

  it("one Wednesday opens exceptionally; the others stay closed", async () => {
    const wednesday = next(3);
    const { error } = await owner.client.rpc("set_business_date_ranges", {
      p_business_id: business.id,
      p_date: wednesday,
      p_ranges: [{ starts_at: "14:00", ends_at: "16:00" }],
      p_expected: null,
    });
    expect(error).toBeNull();

    const [opened] = await calendar(wednesday, wednesday);
    expect(times(opened!.slots)).toEqual(["14:00", "14:30", "15:00"]);
    const [following] = await calendar(
      plusDays(wednesday, 7),
      plusDays(wednesday, 7),
    );
    expect(following!.slots).toEqual([]);

    const booked = await book(await instant(wednesday, "14:00"));
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    // Her usual morning hours do not apply on that date.
    const morning = await book(await instant(wednesday, "10:00"));
    expect(morning.status).toBe(409);
    expect(await appointmentsOn(wednesday)).toBe(1);
  });

  it("her change applies at once: Wednesday back, then a week with no day open", async () => {
    const later = next(3, 9);
    await saveWeek([
      ...WEEK,
      { weekday: 3, startsAt: "09:00", endsAt: "12:00" },
    ]);
    expect((await calendar(later, later))[0]!.slots).not.toEqual([]);

    await saveWeek([]);
    const from = localDate(2);
    const days = await calendar(from, plusDays(from, 13));
    const open = days.filter((day) => day.slots.length).map((day) => day.date);
    // Only the exceptional date set above is still open.
    expect(open).toEqual([next(3)]);
    const refused = await book(await instant(later, "10:00"));
    expect(refused.status).toBe(409);

    await saveWeek(WEEK);
  });

  it("closing a day stops online booking only: her agenda still takes a client", async () => {
    const sunday = next(0);
    const { data, error } = await owner.client
      .rpc("agenda_create_appointment", {
        p_business_id: business.id,
        p_service_id: service,
        p_starts_at: await instant(sunday, "10:00"),
        p_request_id: randomUUID(),
        p_client_first_name: "Maya",
      })
      .single();
    expect(error).toBeNull();
    expect(data!.created).toBe(true);
    expect(await appointmentsOn(sunday)).toBe(1);
    // Still closed to online booking.
    expect((await calendar(sunday, sunday))[0]!.slots).toEqual([]);
  });
});
