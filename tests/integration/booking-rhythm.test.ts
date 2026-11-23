import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as postBooking } from "@/app/api/bookings/route";
import { GET as getAvailability } from "@/app/api/public/businesses/[slug]/availability/route";
import {
  getBookingSettings,
  listBusinessHours,
  replaceBusinessHours,
  updateBookingSettings,
} from "@/features/availability/data/schedule";
import type { BookingRhythm } from "@/features/availability/schemas/availability";

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

// Points 220 and 221 (Higani backlog): the rhythm of her online bookings,
// as she sets it in « Horaires ». Her slots start at her opening time (9:05
// included) and then every interval she chose; the time kept after each
// appointment follows her choice; the booking route refuses what the public
// calendar does not offer. (The notice, point 222, has its own editor.)
//
// Case: Europe/Paris, open 09:05–11:00 every day, « Coupe » 30 min, notice
// 2 h (dates from 3 days on), horizon 28 days. Each test sets the whole
// rhythm it needs.

const SECRET = "booking-rhythm-test-proxy-secret-0123456789a";
const BASE = "http://localhost:3000";
const TZ = "Europe/Paris";

type Slot = { startsAt: string; localStartsAt: string };

let owner: Professional;
let business: TestBusiness;
let service: string;

const localDate = (daysFromToday: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(Date.now() + daysFromToday * 86_400_000),
  );

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

/** The local start times the public calendar offers on one date. */
async function slotsOn(date: string) {
  const query = new URLSearchParams({
    serviceId: service,
    date,
    through: date,
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
  const days = body.data.days as { date: string; slots: Slot[] }[];
  expect(days.map((day) => day.date)).toEqual([date]);
  return days[0]!.slots.map((slot) => slot.localStartsAt.slice(11, 16));
}

async function book(date: string, time: string) {
  const response = await postBooking(
    request("POST", "/api/bookings", {
      slug: business.slug,
      serviceId: service,
      startsAt: await instant(date, time),
      firstName: "Lou",
      email: `lou-${randomUUID().slice(0, 8)}@client.test`,
      requestId: randomUUID(),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/** As her « Rythme des réservations » saves it (setBookingRhythmAction). */
const setRhythm = (rhythm: BookingRhythm) =>
  updateBookingSettings(owner.client, business.id, rhythm);
const rhythm = (slotIntervalMinutes: number, bufferMinutes = 0) => ({
  slotIntervalMinutes,
  bufferMinutes,
});

beforeAll(async () => {
  process.env.BOOKING_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;

  owner = await createProfessional("booking-rhythm");
  business = await createBusiness(owner.userId, {
    timezone: TZ,
    settings: {
      minimum_booking_notice_minutes: 120,
      maximum_booking_advance_days: 28,
    },
  });
  service = await createService(business.id, {
    name: "Coupe",
    durationMinutes: 30,
  });
  // Saved as her week editor saves it: 9:05 is one of its choices now.
  const current = await listBusinessHours(owner.client, business.id);
  const saved = await replaceBusinessHours(owner.client, business.id, {
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      startsAt: "09:05",
      endsAt: "11:00",
    })),
    expected: current.map(({ weekday, startsAt, endsAt }) => ({
      weekday,
      startsAt,
      endsAt,
    })),
  });
  expect(new Set(saved.map((range) => range.startsAt))).toEqual(
    new Set(["09:05"]),
  );
});

describe("points 220 and 221: the rhythm of her online bookings", () => {
  it("221: she opens at 9:05 and her slots start there", async () => {
    await setRhythm(rhythm(15));
    expect(await slotsOn(localDate(3))).toEqual([
      "09:05",
      "09:20",
      "09:35",
      "09:50",
      "10:05",
      "10:20",
    ]);
  });

  it("220: every 5, 10 or 30 minutes as she chooses; off her grid is refused", async () => {
    const date = localDate(4);

    await setRhythm(rhythm(5));
    const everyFive = await slotsOn(date);
    expect(everyFive).toHaveLength(18);
    expect(everyFive.slice(0, 4)).toEqual(["09:05", "09:10", "09:15", "09:20"]);
    expect(everyFive.at(-1)).toBe("10:30");

    await setRhythm(rhythm(10));
    expect(await slotsOn(date)).toEqual([
      "09:05",
      "09:15",
      "09:25",
      "09:35",
      "09:45",
      "09:55",
      "10:05",
      "10:15",
      "10:25",
    ]);

    await setRhythm(rhythm(30));
    expect(await slotsOn(date)).toEqual(["09:05", "09:35", "10:05"]);

    // 9:15 was a slot a minute ago, not on her grid now: refused, nothing kept.
    const refused = await book(date, "09:15");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("slot_unavailable");
    const booked = await book(date, "09:35");
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(await slotsOn(date)).toEqual(["09:05", "10:05"]);
  });

  it("the time kept after each appointment applies to new bookings only", async () => {
    const date = localDate(5);
    await setRhythm(rhythm(5, 0));
    expect((await book(date, "09:05")).status).toBe(201);
    expect((await slotsOn(date))[0]).toBe("09:35");

    // Now 15 minutes after each appointment: the one already booked keeps
    // what it was booked with, so 9:35 stays free right after it.
    await setRhythm(rhythm(5, 15));
    expect((await slotsOn(date))[0]).toBe("09:35");
    expect((await book(date, "09:35")).status).toBe(201);
    // The new one ends at 10:05 and keeps 15 minutes: next slot 10:20.
    expect(await slotsOn(date)).toEqual(["10:20", "10:25", "10:30"]);
  });

  it("what she saves is read back as saved, within the limits", async () => {
    const saved = await setRhythm(rhythm(45, 60));
    expect(saved).toMatchObject(rhythm(45, 60));
    expect(await getBookingSettings(owner.client, business.id)).toMatchObject(
      rhythm(45, 60),
    );
    // The table refuses what the form never offers.
    await expect(setRhythm(rhythm(3))).rejects.toThrow();
    await expect(setRhythm(rhythm(15, 241))).rejects.toThrow();
    expect(await getBookingSettings(owner.client, business.id)).toMatchObject(
      rhythm(45, 60),
    );
  });
});
