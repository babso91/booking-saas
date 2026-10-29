import { describe, expect, it } from "vitest";

import {
  SAMPLE_TODAY,
  sampleBusyWeek,
  sampleInstant,
  sampleNightWeek,
  sampleTrainingWeek,
  sampleWeek,
} from "../fixtures/sample-week";
import { dayFlow, distinctBookings } from "./day-flow";

const at = (time: string, date = SAMPLE_TODAY) =>
  Date.parse(sampleInstant(date, time));

const kinds = (flow: ReturnType<typeof dayFlow>) =>
  flow.items.map((item) =>
    item.kind === "visits"
      ? `visits:${item.visits.map((v) => v.appointment.client.displayName.split(" ")[0]).join("+")}`
      : item.kind === "free"
        ? `free:${item.time}+${item.minutes}${item.bookable ? "" : "(past)"}`
        : item.kind === "block"
          ? `block:${item.block.reason}`
          : `now:${item.time}`,
  );

describe("dayFlow — a normal day", () => {
  it("visits in order, pause and free time where they fall, now inside the visit going on", () => {
    const flow = dayFlow(sampleWeek, SAMPLE_TODAY, at("14:05"));
    expect(kinds(flow)).toEqual([
      "visits:Inès",
      "free:10:45+15(past)",
      "visits:Camille",
      "free:11:45+15(past)",
      "block:Déjeuner",
      "free:13:15+15(past)",
      "visits:Sarah",
      "free:14:45+15",
      "visits:Léa",
      "free:16:15+15",
      "visits:Nadia",
      "free:17:15+15",
      "visits:Julie",
      "free:18:30+30",
    ]);
    expect(flow.next?.appointment.client.displayName).toBe("Léa Fontaine");
    expect(flow.count).toBe(6);
    expect(flow.closed).toBe(false);
  });

  it("between two visits, « now » sits between them", () => {
    const flow = dayFlow(sampleWeek, SAMPLE_TODAY, at("12:30"));
    expect(kinds(flow).slice(4, 7)).toEqual([
      "block:Déjeuner",
      "now:12:30",
      "free:13:15+15",
    ]);
  });

  it("free time already begun: only what is still ahead is offered", () => {
    const flow = dayFlow(sampleWeek, SAMPLE_TODAY, at("18:42"));
    expect(kinds(flow).slice(-3)).toEqual([
      "visits:Julie",
      "now:18:42",
      "free:18:45+15",
    ]);
  });

  it("another day: no now, nothing invented, free time offered", () => {
    const flow = dayFlow(sampleWeek, "2026-10-29", at("14:05"));
    expect(kinds(flow).some((item) => item.startsWith("now"))).toBe(false);
    expect(flow.next).toBeNull();
    expect(flow.items.find((item) => item.kind === "free")).toMatchObject({
      time: "09:00",
      minutes: 60,
      bookable: true,
    });
  });
});

describe("dayFlow — hard days", () => {
  it("overlaps share one row; a cancelled visit holds no time", () => {
    const flow = dayFlow(sampleBusyWeek, SAMPLE_TODAY, at("14:05"));
    const rows = flow.items.filter((item) => item.kind === "visits");
    expect(
      rows.map((row) => (row.kind === "visits" ? row.visits.length : 0)),
    ).toEqual([4, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    // The cancelled 10:30 is read here (fixture) and shown in its row.
    expect(flow.count).toBe(14);
  });

  it("a visit across midnight is on both days, flagged", () => {
    const tuesday = dayFlow(sampleNightWeek, SAMPLE_TODAY, at("22:00"));
    const night = tuesday.items.at(-1)!;
    expect(night.kind).toBe("visits");
    expect(night.kind === "visits" && night.visits[0]).toMatchObject({
      endsAfter: true,
      startsBefore: false,
    });
    const wednesday = dayFlow(
      sampleNightWeek,
      "2026-10-28",
      at("00:30", "2026-10-28"),
    );
    const first = wednesday.items[0]!;
    expect(first.kind === "visits" && first.visits[0]).toMatchObject({
      startsBefore: true,
      timing: "now",
    });
  });

  it("a partial closure is in the flow; free time around it", () => {
    const flow = dayFlow(
      sampleTrainingWeek,
      "2026-10-29",
      at("08:00", "2026-10-29"),
    );
    expect(kinds(flow)).toEqual([
      "now:08:00",
      "free:09:00+60",
      "block:Formation",
      "block:Déjeuner",
      "free:13:15+345",
    ]);
    expect(flow.closed).toBe(false);
  });

  it("a weekly closing day is closed, with nothing offered", () => {
    const flow = dayFlow(sampleWeek, "2026-11-01", at("11:00", "2026-11-01"));
    expect(flow.closed).toBe(true);
    expect(kinds(flow)).toEqual(["now:11:00"]);
  });
});

describe("distinctBookings", () => {
  const week = sampleWeek.workingHours.days.map((day) => day.date);

  it("one booking across midnight counts once in the week", () => {
    expect(distinctBookings(sampleWeek, week)).toBe(25);
    expect(distinctBookings(sampleNightWeek, week)).toBe(26);
    // A day counts the bookings that start on it.
    expect(distinctBookings(sampleNightWeek, [SAMPLE_TODAY])).toBe(7);
    expect(distinctBookings(sampleNightWeek, ["2026-10-28"])).toBe(5);
  });

  it("cancelled ones only when asked", () => {
    expect(distinctBookings(sampleBusyWeek, [SAMPLE_TODAY])).toBe(13);
    expect(distinctBookings(sampleBusyWeek, [SAMPLE_TODAY], true)).toBe(14);
  });
});
