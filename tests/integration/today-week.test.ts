import { describe, expect, it } from "vitest";

import { getAgenda } from "@/features/agenda/data/agenda";
import { dayFlow } from "@/features/dashboard/agenda/day-flow";
import { todayModel } from "@/features/dashboard/client/today-model";
import { readTodayWeek } from "@/features/dashboard/data/today-week";
import { addDaysToLocalDate } from "@/lib/time/local-date";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  insertAppointment,
  setWeeklyHours,
} from "./support/fixtures";

// "Aujourd’hui" on a Monday, against PostgreSQL (the calendar authority):
// real weekly hours, real zones, real day bounds. A visit on Sunday
// 23:30–23:50 whose buffer runs past midnight still holds the first minutes
// of Monday's opening (00:00–02:00); the week read for the page must know
// it, as the agenda's own read does. Critical instants are explicit UTC.

const MINUTE = 60_000;

type Case = {
  name: string;
  timezone: string;
  monday: string;
  /** Sunday 23:30 in the business's zone, as UTC. */
  lateSunday: string;
};

const cases: Case[] = [
  {
    name: "Sunday → Monday (Paris)",
    timezone: "Europe/Paris",
    monday: "2026-11-02",
    lateSunday: "2026-11-01T22:30:00Z",
  },
  {
    name: "end of a month (Paris, summer time)",
    timezone: "Europe/Paris",
    monday: "2026-06-01",
    lateSunday: "2026-05-31T21:30:00Z",
  },
  {
    name: "end of a year (Paris)",
    timezone: "Europe/Paris",
    monday: "2029-01-01",
    lateSunday: "2028-12-31T22:30:00Z",
  },
  {
    name: "a Sunday of 25 hours, the clocks went back (Paris)",
    timezone: "Europe/Paris",
    monday: "2026-10-26",
    lateSunday: "2026-10-25T22:30:00Z",
  },
  {
    name: "a Sunday of 25 hours (New York)",
    timezone: "America/New_York",
    monday: "2026-11-02",
    lateSunday: "2026-11-02T04:30:00Z",
  },
  {
    name: "a zone ahead of UTC by 13 hours (Auckland)",
    timezone: "Pacific/Auckland",
    monday: "2026-11-02",
    lateSunday: "2026-11-01T10:30:00Z",
  },
];

async function business(timezone: string) {
  const owner = await createProfessional("today-week");
  const created = await createBusiness(owner.userId, { timezone });
  // Open on Mondays only, 00:00–02:00 her time.
  await setWeeklyHours(created.id, [[1, "00:00", "02:00"]]);
  const serviceId = await createService(created.id, { durationMinutes: 20 });
  const clientId = await createClientRecord(
    created.id,
    `lou-${created.id.slice(0, 8)}@x.test`,
  );
  return {
    client: owner.client,
    context: { businessId: created.id, timezone },
    async visit(startsAt: string, bufferMinutes: number) {
      return insertAppointment({
        businessId: created.id,
        clientId,
        serviceId,
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + 20 * MINUTE).toISOString(),
        bufferMinutes,
      });
    },
  };
}

const freeOf = (week: Awaited<ReturnType<typeof getAgenda>>, date: string) =>
  dayFlow(week, date, null).freeMinutes;

describe.each(cases)("$name", ({ timezone, monday, lateSunday }) => {
  it("Monday is taken until 00:20: 1 h 40 free, not 2 h", async () => {
    const s = await business(timezone);
    const late = await s.visit(lateSunday, 30);

    const week = await readTodayWeek(s.client, s.context, monday);

    expect(week.workingHours.days.map((day) => day.date)).toEqual(
      Array.from({ length: 7 }, (_, index) =>
        addDaysToLocalDate(monday, index),
      ),
    );
    const opening = week.workingHours.days[0]!.openRanges[0]!;
    expect(opening.localStartsAt).toBe(`${monday}T00:00`);
    expect(opening.localEndsAt).toBe(`${monday}T02:00`);
    expect(week.appointments.map((item) => item.id)).toEqual([late]);
    // It holds time; it is not one of Monday's visits.
    expect(todayModel(week, monday, Date.parse(lateSunday)).visits).toEqual([]);
    expect(freeOf(week, monday)).toBe(100);

    // Read from Monday alone, as the page did, the 20 minutes looked free.
    const before = await getAgenda(s.client, s.context, {
      startDate: monday,
      endDate: addDaysToLocalDate(monday, 6),
      includeCancelled: false,
    });
    expect(freeOf(before, monday)).toBe(120);
  });

  it("a buffer ending exactly at the opening holds none of it", async () => {
    const s = await business(timezone);
    await s.visit(lateSunday, 10);
    const week = await readTodayWeek(s.client, s.context, monday);
    expect(week.appointments).toEqual([]);
    expect(freeOf(week, monday)).toBe(120);
  });

  it("without buffer, the week is exactly the one read from Monday", async () => {
    const s = await business(timezone);
    await s.visit(lateSunday, 0);
    const week = await readTodayWeek(s.client, s.context, monday);
    const before = await getAgenda(s.client, s.context, {
      startDate: monday,
      endDate: addDaysToLocalDate(monday, 6),
      includeCancelled: false,
    });
    expect(week.appointments).toEqual(before.appointments);
    expect(week.workingHours.days).toEqual(before.workingHours.days);
    expect(freeOf(week, monday)).toBe(120);
  });
});
