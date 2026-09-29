import { describe, expect, it } from "vitest";

import {
  agenda,
  appointment,
  block,
  instantOf,
} from "../../../../tests/support/agenda-fixtures";
import {
  allDayBlocks,
  buildAxis,
  coversWholeDay,
  isAllDayBlock,
  placeAppointments,
  placeBlocks,
  segmentOn,
  timeAt,
  visibleWindow,
  type Segment,
} from "./layout";

// Every period is built from real UTC instants; local values are derived.
const total = (segment: Segment | null) =>
  segment
    ? segment.pieces.reduce((sum, piece) => sum + piece.bottom - piece.top, 0)
    : 0;

const real = (startsAt: string, endsAt: string) => ({ startsAt, endsAt });

describe("normal 24 h days", () => {
  const axis = buildAxis(
    ["2026-09-28", "2026-09-29", "2026-09-30"],
    "Europe/Paris",
  );

  it("places items from their real instants", () => {
    const item = appointment({
      local: "2026-09-29T10:00",
      durationMinutes: 75,
    });
    expect(segmentOn(axis, item, "2026-09-29")).toMatchObject({
      top: 600,
      bottom: 675,
      pieces: [{ top: 600, bottom: 675 }],
    });
    expect(segmentOn(axis, item, "2026-09-28")).toBeNull();
    expect(segmentOn(axis, item, "2026-09-30")).toBeNull();
    expect(axis.frames.get("2026-09-29")).toMatchObject({
      endY: 1440,
      gaps: [],
    });
    expect(axis.band).toBeNull();
  });

  it("splits a period crossing midnight on both days, keeping its duration", () => {
    const night = block({ from: "2026-09-29T22:00", to: "2026-09-30T02:00" });
    const first = segmentOn(axis, night, "2026-09-29");
    const second = segmentOn(axis, night, "2026-09-30");
    expect(first).toMatchObject({
      top: 1320,
      bottom: 1440,
      continuesAfter: true,
      continuesBefore: false,
    });
    expect(second).toMatchObject({
      top: 0,
      bottom: 120,
      continuesBefore: true,
      continuesAfter: false,
    });
    expect(total(first) + total(second)).toBe(240);
    expect(segmentOn(axis, night, "2026-09-28")).toBeNull();
  });

  it("puts overlapping appointments side by side", () => {
    const a = appointment({ local: "2026-09-29T10:00", durationMinutes: 60 });
    const b = appointment({
      local: "2026-09-29T10:30",
      durationMinutes: 60,
      status: "cancelled",
    });
    const c = appointment({ local: "2026-09-29T14:00", durationMinutes: 60 });
    expect(
      placeAppointments(axis, [a, b, c], "2026-09-29").map((item) => [
        item.lane,
        item.lanes,
      ]),
    ).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });

  it("widens the visible window to opening ranges and items", () => {
    const data = agenda("2026-09-29", "2026-09-29", {
      appointments: [
        appointment({ local: "2026-09-29T06:30", durationMinutes: 60 }),
      ],
    });
    expect(
      visibleWindow(
        axis,
        ["2026-09-29"],
        data.appointments,
        [],
        data.workingHours.days,
      ),
    ).toEqual({
      startY: 360,
      endY: 1260,
    });
  });
});

describe("Europe/Paris — back to winter time (25 h day, 25 Oct 2026)", () => {
  // 02:00–02:59 happens twice: 00:00Z–00:59Z (UTC+2), then 01:00Z–01:59Z (UTC+1).
  const days = ["2026-10-24", "2026-10-25", "2026-10-26"];
  const axis = buildAxis(days, "Europe/Paris");
  const DST = "2026-10-25";

  const onlyOn = (item: { startsAt: string; endsAt: string }, date: string) => {
    for (const other of days.filter((day) => day !== date)) {
      expect(segmentOn(axis, item, other)).toBeNull();
    }
  };

  it("inserts a band for the repeated hour: 25 h day, 24 h neighbours with an empty band", () => {
    expect(axis.band).toEqual({ date: DST, start: 120, end: 180 });
    expect(axis.frames.get(DST)).toMatchObject({ endY: 1500, gaps: [] });
    expect(axis.frames.get("2026-10-24")).toMatchObject({
      endY: 1500,
      gaps: [{ top: 180, bottom: 240 }],
    });
    const labels = axis.marks
      .filter((mark) => mark.y >= 120 && mark.y <= 240)
      .map((mark) => [mark.y, mark.label, mark.repeated]);
    expect(labels).toEqual([
      [120, "02:00", false],
      [180, "02:00", true],
      [240, "03:00", false],
    ]);
  });

  it("1. first occurrence of 02:30 (UTC+2)", () => {
    const first = appointment({
      local: "2026-10-25T02:30",
      occurrence: "first",
      durationMinutes: 60,
    });
    expect(first.startsAt).toBe("2026-10-25T00:30:00.000Z");
    expect(segmentOn(axis, first, DST)).toMatchObject({
      top: 150,
      bottom: 210,
      pieces: [{ top: 150, bottom: 210 }],
    });
    onlyOn(first, DST);
  });

  it("2. second occurrence of 02:30 (UTC+1) sits one real hour lower", () => {
    const second = appointment({
      local: "2026-10-25T02:30",
      occurrence: "second",
      durationMinutes: 60,
    });
    expect(second.startsAt).toBe("2026-10-25T01:30:00.000Z");
    expect(segmentOn(axis, second, DST)).toMatchObject({
      top: 210,
      bottom: 270,
    });
    onlyOn(second, DST);
  });

  it("3. an event crossing both occurrences keeps its real two hours", () => {
    const crossing = block(
      real(
        instantOf("2026-10-25T01:30"),
        instantOf("2026-10-25T02:30", "second"),
      ),
    );
    expect(crossing.localStartsAt).toBe("2026-10-25T01:30");
    expect(crossing.localEndsAt).toBe("2026-10-25T02:30");
    const segment = segmentOn(axis, crossing, DST);
    expect(segment).toMatchObject({ top: 90, bottom: 210 });
    expect(total(segment)).toBe(120);
    onlyOn(crossing, DST);
  });

  it("4. a 02:30 → 02:30 block is one real hour", () => {
    const repeated = block({
      from: "2026-10-25T02:30",
      fromOccurrence: "first",
      to: "2026-10-25T02:30",
      toOccurrence: "second",
    });
    expect(repeated.localStartsAt).toBe(repeated.localEndsAt);
    expect(placeBlocks(axis, [repeated], DST)).toMatchObject([
      { top: 150, bottom: 210 },
    ]);
    expect(total(segmentOn(axis, repeated, DST))).toBe(60);
  });

  it("5. nothing leaks to the adjacent days", () => {
    const items = [
      block({
        from: "2026-10-25T02:30",
        fromOccurrence: "first",
        to: "2026-10-25T02:30",
        toOccurrence: "second",
      }),
      appointment({ local: "2026-10-25T02:30", occurrence: "second" }),
      appointment({ local: "2026-10-25T23:00", durationMinutes: 60 }),
    ];
    for (const item of items) onlyOn(item, DST);
  });

  it("maps a click back to the right wall-clock time", () => {
    expect(timeAt(axis, DST, 150)).toBe("02:30");
    expect(timeAt(axis, DST, 210)).toBe("02:30");
    expect(timeAt(axis, DST, 300)).toBe("04:00");
    expect(timeAt(axis, "2026-10-24", 200)).toBeNull(); // empty band on a 24 h day
    expect(timeAt(axis, "2026-10-24", 300)).toBe("04:00");
  });

  it("10. a full-day block covers the 25 h day, whatever its length", () => {
    const closure = block({
      kind: "closed",
      from: "2026-10-25T00:00",
      to: "2026-10-26T00:00",
    });
    expect(isAllDayBlock(closure)).toBe(true);
    expect(coversWholeDay(axis, closure, DST)).toBe(true);
    expect(allDayBlocks(axis, [closure], DST)).toHaveLength(1);
    expect(placeBlocks(axis, [closure], DST)).toHaveLength(0);
    expect(allDayBlocks(axis, [closure], "2026-10-24")).toHaveLength(0);
    expect(allDayBlocks(axis, [closure], "2026-10-26")).toHaveLength(0);
  });
});

describe("Europe/Paris — spring forward (23 h day, 29 Mar 2026)", () => {
  const days = ["2026-03-28", "2026-03-29", "2026-03-30"];
  const axis = buildAxis(days, "Europe/Paris");
  const DST = "2026-03-29";

  it("7. a 23 h day shows its skipped hour as a strip without time", () => {
    expect(axis.band).toBeNull();
    expect(axis.frames.get(DST)).toMatchObject({
      skipped: { top: 120, bottom: 180 },
      gaps: [{ top: 120, bottom: 180 }],
    });
    expect(axis.frames.get("2026-03-28")?.gaps).toEqual([]);
    expect(timeAt(axis, DST, 150)).toBeNull();
  });

  it("an event over the skipped hour is drawn in two pieces worth its real hour", () => {
    const hour = block(
      real(instantOf("2026-03-29T01:30"), instantOf("2026-03-29T03:30")),
    ); // 00:30Z → 01:30Z
    const segment = segmentOn(axis, hour, DST);
    expect(segment?.pieces).toEqual([
      { top: 90, bottom: 120 },
      { top: 180, bottom: 210 },
    ]);
    expect(total(segment)).toBe(60);
    expect(segmentOn(axis, hour, "2026-03-28")).toBeNull();
    expect(segmentOn(axis, hour, "2026-03-30")).toBeNull();
  });
});

describe("Africa/Cairo — Codex counterexample (clocks back at 24:00 on 29 Oct 2026)", () => {
  const days = [
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
  ];
  const axis = buildAxis(days, "Africa/Cairo");
  const repeated = block({
    timeZone: "Africa/Cairo",
    startsAt: "2026-10-29T20:30:00.000Z",
    endsAt: "2026-10-29T21:30:00.000Z",
  });

  it("reads 23:30 → 23:30 locally", () => {
    expect(repeated.localStartsAt).toBe("2026-10-29T23:30");
    expect(repeated.localEndsAt).toBe("2026-10-29T23:30");
  });

  it("appears only on its real day, one real hour tall", () => {
    const placed = placeBlocks(axis, [repeated], "2026-10-29");
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      top: 1410,
      bottom: 1470,
      continuesAfter: false,
    });
    expect(total(placed[0]!)).toBe(60);
  });

  it("never appears on 30 Oct, 31 Oct or 1 Nov (nor before)", () => {
    for (const date of days.filter((day) => day !== "2026-10-29")) {
      expect(placeBlocks(axis, [repeated], date)).toEqual([]);
      expect(allDayBlocks(axis, [repeated], date)).toEqual([]);
    }
  });

  it("8. the 25 h day ends one hour lower; its band sits after midnight on other days", () => {
    expect(axis.band).toEqual({ date: "2026-10-29", start: 1380, end: 1440 });
    expect(axis.frames.get("2026-10-29")?.endY).toBe(1500);
    expect(axis.frames.get("2026-10-30")).toMatchObject({
      endY: 1440,
      gaps: [{ top: 1440, bottom: 1500 }],
    });
  });
});
