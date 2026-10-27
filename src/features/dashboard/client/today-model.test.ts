import { describe, expect, it } from "vitest";

import type { AgendaDto } from "@/features/agenda/data/agenda";

import {
  SAMPLE_TODAY,
  sampleInstant,
  sampleWeek,
} from "../fixtures/sample-week";
import { minutesUntil, positionOf, todayModel } from "./today-model";

const at = (time: string, date = SAMPLE_TODAY) =>
  Date.parse(sampleInstant(date, time));

const names = (model: ReturnType<typeof todayModel>) =>
  model.visits.map((visit) => visit.appointment.client.displayName);

describe("todayModel", () => {
  it("keeps only the visits of that date, in order, never cancelled ones", () => {
    const cancelled: AgendaDto = {
      ...sampleWeek,
      appointments: sampleWeek.appointments.map((appointment) =>
        appointment.client.displayName === "Julie Martin"
          ? { ...appointment, status: "cancelled" }
          : appointment,
      ),
    };
    const model = todayModel(cancelled, SAMPLE_TODAY, at("10:00"));
    expect(names(model)).toEqual([
      "Inès Bouchard",
      "Camille Roux",
      "Sarah Benali",
      "Léa Fontaine",
      "Nadia Haddad",
    ]);
  });

  it("during a visit: what is going on, and what comes next", () => {
    const model = todayModel(sampleWeek, SAMPLE_TODAY, at("14:05"));
    expect(model.phase).toBe("during");
    expect(model.nowTime).toBe("14:05");
    expect(model.current?.appointment.client.displayName).toBe("Sarah Benali");
    expect(model.next?.appointment.client.displayName).toBe("Léa Fontaine");
    expect(model.counts).toEqual({ total: 6, done: 2, left: 4, online: 2 });
    expect(minutesUntil(model.current!.end, at("14:05"))).toBe(40);
  });

  it("between two visits, before the first, after the last", () => {
    expect(todayModel(sampleWeek, SAMPLE_TODAY, at("12:30")).phase).toBe(
      "between",
    );
    const fresh: AgendaDto = {
      ...sampleWeek,
      appointments: sampleWeek.appointments.map((appointment) => ({
        ...appointment,
        status: "confirmed",
      })),
    };
    const before = todayModel(fresh, SAMPLE_TODAY, at("08:40"));
    expect(before.phase).toBe("before");
    expect(before.next?.appointment.client.displayName).toBe("Inès Bouchard");
    const after = todayModel(fresh, SAMPLE_TODAY, at("19:10"));
    expect(after.phase).toBe("after");
    expect(after.current).toBeNull();
    expect(after.next).toBeNull();
  });

  it("a visit marked done or absent is behind her, even before its end", () => {
    const early: AgendaDto = {
      ...sampleWeek,
      appointments: sampleWeek.appointments.map((appointment) =>
        appointment.client.displayName === "Sarah Benali"
          ? { ...appointment, status: "no_show" }
          : appointment,
      ),
    };
    const model = todayModel(early, SAMPLE_TODAY, at("14:05"));
    expect(model.phase).toBe("between");
    expect(model.current).toBeNull();
  });

  it("a day with nothing booked is free; a day with no opening is closed", () => {
    const sunday = todayModel(
      sampleWeek,
      "2026-11-01",
      at("11:00", "2026-11-01"),
    );
    expect(sunday.phase).toBe("free");
    expect(sunday.closed).toBe(true);
    // Closed and empty: the line covers the whole civil day.
    expect(sunday.span).toEqual({
      start: at("00:00", "2026-11-01"),
      end: at("00:00", "2026-11-02"),
    });
  });

  it("past midnight in her time zone, now is no longer on that date", () => {
    const model = todayModel(
      sampleWeek,
      SAMPLE_TODAY,
      at("00:05", "2026-10-28"),
    );
    expect(model.nowTime).toBeNull();
  });

  it("the day's line: her opening, hour marks labelled by her wall clock", () => {
    const model = todayModel(sampleWeek, SAMPLE_TODAY, at("14:05"));
    expect(model.span).toEqual({ start: at("09:00"), end: at("19:00") });
    expect(model.ticks.map((tick) => tick.label)).toEqual([
      "9 h",
      "10 h",
      "11 h",
      "12 h",
      "13 h",
      "14 h",
      "15 h",
      "16 h",
      "17 h",
      "18 h",
      "19 h",
    ]);
    expect(positionOf(model.span, at("14:00"))).toBe(50);
    expect(model.pauses).toEqual([
      expect.objectContaining({ label: "Déjeuner", start: at("12:00") }),
    ]);
  });

  it("a visit outside her opening widens the line rather than vanish", () => {
    const late: AgendaDto = {
      ...sampleWeek,
      appointments: [
        ...sampleWeek.appointments,
        {
          ...sampleWeek.appointments[0]!,
          id: "late",
          startsAt: sampleInstant(SAMPLE_TODAY, "19:30"),
          endsAt: sampleInstant(SAMPLE_TODAY, "20:15"),
          localStartsAt: `${SAMPLE_TODAY}T19:30`,
          localEndsAt: `${SAMPLE_TODAY}T20:15`,
        },
      ],
    };
    expect(todayModel(late, SAMPLE_TODAY, at("14:05")).span.end).toBe(
      at("20:15"),
    );
  });

  it("the week: open and booked minutes per day, today marked", () => {
    const { week } = todayModel(sampleWeek, SAMPLE_TODAY, at("14:05"));
    expect(week.map((day) => day.date)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    expect(week[1]).toMatchObject({
      isToday: true,
      openMinutes: 600,
      bookedMinutes: 105 + 45 + 75 + 75 + 45 + 60,
      visits: 6,
    });
    expect(week[6]).toMatchObject({ openMinutes: 0, visits: 0 });
  });

  it("her notes on what is still to come, not on what is done", () => {
    const model = todayModel(sampleWeek, SAMPLE_TODAY, at("16:00"));
    expect(
      model.notes.map(({ appointment }) => appointment.client.displayName),
    ).toEqual(["Léa Fontaine", "Nadia Haddad"]);
    const later = todayModel(sampleWeek, SAMPLE_TODAY, at("16:20"));
    expect(
      later.notes.map(({ appointment }) => appointment.client.displayName),
    ).toEqual(["Nadia Haddad"]);
  });
});
