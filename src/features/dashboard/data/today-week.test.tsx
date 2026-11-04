// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgendaDto } from "@/features/agenda/data/agenda";
import { getAgenda } from "@/features/agenda/data/agenda";
import { dayFlow } from "@/features/dashboard/agenda/day-flow";
import { CarnetToday } from "@/features/dashboard/carnet/carnet-today";
import { todayModel } from "@/features/dashboard/client/today-model";
import { StudioToday } from "@/features/dashboard/components/studio-today";
import { EcrinToday } from "@/features/dashboard/ecrin/ecrin-today";
import { addDaysToLocalDate } from "@/lib/time/local-date";

import {
  agenda,
  appointment,
  instantOf,
} from "../../../../tests/support/agenda-fixtures";
import { readTodayWeek } from "./today-week";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/agenda/data/agenda", () => ({ getAgenda: vi.fn() }));

// "Aujourd’hui" reads its week as the agenda does when free time matters:
// from the day before (agendaRangeWithBuffers), then only what reaches the
// week (restrictToDays, buffers). The database's answer is played by the
// fixtures: what overlaps the asked range, Monday opening 00:00–02:00.
// Real hours and zones from PostgreSQL: tests/integration/today-week.test.ts.

const context = { businessId: "b-1", timezone: "Europe/Paris" };
const client = {} as Parameters<typeof readTodayWeek>[0];

function database(
  appointments: ReturnType<typeof appointment>[],
  monday: string,
) {
  vi.mocked(getAgenda).mockImplementation(
    async (_client, _context, { startDate, endDate }) => {
      const from = Date.parse(instantOf(`${startDate}T00:00`));
      const to = Date.parse(
        instantOf(`${addDaysToLocalDate(endDate, 1)}T00:00`),
      );
      const read = agenda(startDate, endDate, {
        appointments: appointments.filter(
          (item) =>
            Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from,
        ),
      });
      return {
        ...read,
        workingHours: {
          ...read.workingHours,
          days: read.workingHours.days.map((day) =>
            day.date === monday
              ? {
                  ...day,
                  openRanges: [
                    {
                      startsAt: instantOf(`${monday}T00:00`),
                      endsAt: instantOf(`${monday}T02:00`),
                      localStartsAt: `${monday}T00:00`,
                      localEndsAt: `${monday}T02:00`,
                    },
                  ],
                }
              : day,
          ),
        },
      };
    },
  );
}

/** Sunday 23:30–23:50, with `buffer` minutes after. */
const lateSunday = (sunday: string, buffer: number) =>
  appointment({
    local: `${sunday}T23:30`,
    durationMinutes: 20,
    bufferMinutes: buffer,
    client: { id: "c-1", displayName: "Lou Martin" },
  });

/** What the page read before: Monday to Sunday, nothing of the day before. */
const mondayOnly = (monday: string) =>
  getAgenda(client, context, {
    startDate: monday,
    endDate: addDaysToLocalDate(monday, 6),
    includeCancelled: false,
  });

const freeOf = (week: AgendaDto, date: string) =>
  dayFlow(week, date, Date.parse(instantOf(`${date}T00:00`))).freeMinutes;

function register() {
  return screen.getByRole("row", { name: /Temps libre à venir/ }).textContent;
}

beforeEach(() => {
  vi.mocked(getAgenda).mockReset();
});

describe.each([
  ["Sunday → Monday", "2026-11-02"],
  ["end of a month", "2026-06-01"],
  ["end of a year", "2029-01-01"],
  ["a Sunday of 25 hours (the clocks go back)", "2026-10-26"],
])("%s", (_case, monday) => {
  const sunday = addDaysToLocalDate(monday, -1);

  it("reads from the day before, and keeps what its buffer still holds", async () => {
    const late = lateSunday(sunday, 30);
    const early = appointment({ local: `${sunday}T15:00`, bufferMinutes: 30 });
    database([early, late], monday);

    const week = await readTodayWeek(client, context, monday);

    expect(getAgenda).toHaveBeenCalledWith(client, context, {
      startDate: sunday,
      endDate: addDaysToLocalDate(monday, 6),
      includeCancelled: false,
    });
    // Her week, Monday to Sunday: the day before is not one of its days.
    expect(week.workingHours.days.map((day) => day.date)).toEqual(
      Array.from({ length: 7 }, (_, index) =>
        addDaysToLocalDate(monday, index),
      ),
    );
    // Only the visit whose buffer reaches Monday; it holds time and is not
    // one of Monday's visits.
    expect(week.appointments.map((item) => item.id)).toEqual([late.id]);
    expect(todayModel(week, monday, Date.now()).visits).toEqual([]);
    expect(freeOf(week, monday)).toBe(100);

    // As the page read it before: from Monday, the first 20 minutes looked
    // free.
    expect(freeOf(await mondayOnly(monday), monday)).toBe(120);
  });

  it("Carnet writes 1 h 40 free, not 2 h, and no visit on Monday", async () => {
    database([lateSunday(sunday, 30)], monday);
    const week = await readTodayWeek(client, context, monday);
    render(
      <CarnetToday
        agenda={week}
        date={monday}
        serverNow={Date.parse(instantOf(`${monday}T00:00`))}
        frozenNow={Date.parse(instantOf(`${monday}T00:00`))}
      />,
    );
    expect(register()).toMatch(/1 h 40/);
    expect(
      screen.getByRole("row", { name: /^Rendez-vous/ }).textContent,
    ).toMatch(/0|—/);
    expect(screen.queryByText(/Lou Martin/)).toBeNull();
  });
});

describe("the buffer and the opening", () => {
  const monday = "2026-11-02";
  const sunday = "2026-11-01";

  it("a buffer ending exactly at the opening holds nothing of it", async () => {
    database([lateSunday(sunday, 10)], monday);
    const week = await readTodayWeek(client, context, monday);
    expect(week.appointments).toEqual([]);
    expect(freeOf(week, monday)).toBe(120);
  });

  it("without buffer, the week is exactly the one read from Monday", async () => {
    database(
      [lateSunday(sunday, 0), appointment({ local: `${monday}T01:00` })],
      monday,
    );
    const week = await readTodayWeek(client, context, monday);
    const before = await mondayOnly(monday);
    expect(week.appointments).toEqual(before.appointments);
    expect(week.workingHours.days).toEqual(before.workingHours.days);
    expect(freeOf(week, monday)).toBe(freeOf(before, monday));
  });

  it.each([
    ["Studio", StudioToday],
    ["Écrin", EcrinToday],
  ])(
    "%s, which counts visits and not free time, says the same with or without it",
    async (_style, Today) => {
      database([lateSunday(sunday, 30)], monday);
      const week = await readTodayWeek(client, context, monday);
      const props = {
        date: monday,
        serverNow: Date.parse(instantOf(`${monday}T00:00`)),
        frozenNow: Date.parse(instantOf(`${monday}T00:00`)),
      };
      const withIt = render(<Today agenda={week} {...props} />);
      const said = withIt.container.textContent;
      withIt.unmount();
      const without = render(
        <Today agenda={{ ...week, appointments: [] }} {...props} />,
      );
      expect(without.container.textContent).toBe(said);
      expect(said).not.toMatch(/Lou Martin/);
    },
  );
});
