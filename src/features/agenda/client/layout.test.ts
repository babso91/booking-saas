import { describe, expect, it } from "vitest";

import {
  agenda,
  appointment,
  block,
} from "../../../../tests/support/agenda-fixtures";
import {
  allDayBlocks,
  coversWholeDay,
  isAllDayBlock,
  placeAppointments,
  placeBlocks,
  segmentOn,
  visibleHours,
} from "./layout";

describe("agenda layout", () => {
  it("places an appointment from its wall-clock start", () => {
    const item = appointment({
      local: "2026-09-29T10:00",
      durationMinutes: 75,
    });
    expect(segmentOn(item, "2026-09-29")).toMatchObject({
      top: 600,
      height: 75,
    });
    expect(segmentOn(item, "2026-09-30")).toBeNull();
  });

  it("keeps a 02:30 → 02:30 block (repeated autumn hour) with its real one-hour length", () => {
    const repeated = block({
      localStartsAt: "2026-10-25T02:30",
      localEndsAt: "2026-10-25T02:30",
      startsAt: "2026-10-25T00:30:00.000Z",
      endsAt: "2026-10-25T01:30:00.000Z",
      startOccurrence: "first",
      endOccurrence: "second",
    });
    expect(segmentOn(repeated, "2026-10-25")).toMatchObject({
      top: 150,
      height: 60,
    });
    expect(placeBlocks([repeated], "2026-10-25")).toHaveLength(1);
  });

  it("splits a period crossing midnight over two days", () => {
    const night = block({
      localStartsAt: "2026-09-30T22:00",
      localEndsAt: "2026-10-01T02:00",
    });
    expect(segmentOn(night, "2026-09-30")).toMatchObject({
      top: 1320,
      height: 120,
      continuesAfter: true,
    });
    expect(segmentOn(night, "2026-10-01")).toMatchObject({
      top: 0,
      height: 120,
      continuesBefore: true,
    });
  });

  it("treats whole local days as all-day, whatever the day length", () => {
    // 2026-10-25 lasts 25 hours in Paris: coverage is decided on local dates.
    const closure = block({
      kind: "closed",
      localStartsAt: "2026-10-25T00:00",
      localEndsAt: "2026-10-27T00:00",
    });
    expect(isAllDayBlock(closure)).toBe(true);
    expect(coversWholeDay(closure, "2026-10-25")).toBe(true);
    expect(coversWholeDay(closure, "2026-10-26")).toBe(true);
    expect(allDayBlocks([closure], "2026-10-27")).toHaveLength(0);
    expect(placeBlocks([closure], "2026-10-25")).toHaveLength(0);
  });

  it("puts overlapping appointments side by side", () => {
    const a = appointment({ local: "2026-09-29T10:00", durationMinutes: 60 });
    const b = appointment({
      local: "2026-09-29T10:30",
      durationMinutes: 60,
      status: "cancelled",
    });
    const c = appointment({ local: "2026-09-29T14:00", durationMinutes: 60 });
    const placed = placeAppointments([a, b, c], "2026-09-29");
    expect(placed.map((item) => [item.lane, item.lanes])).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });

  it("widens the visible hours to opening ranges and items", () => {
    const data = agenda("2026-09-29", "2026-09-29", {
      appointments: [
        appointment({ local: "2026-09-29T06:30", durationMinutes: 60 }),
      ],
    });
    expect(
      visibleHours(
        ["2026-09-29"],
        data.appointments,
        [],
        data.workingHours.days,
      ),
    ).toEqual({
      startHour: 6,
      endHour: 21,
    });
  });
});
