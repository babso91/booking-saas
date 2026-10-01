import { describe, expect, it } from "vitest";

import {
  agenda,
  appointment,
  block,
  instantOf,
} from "../../../../tests/support/agenda-fixtures";
import {
  intlDayBounds,
  intlZone,
} from "../../../../tests/support/zone-fixture";
import {
  allDayBlocks,
  buildAxis,
  coversWholeDay,
  isAllDayBlock,
  placeAppointments,
  placeBlocks,
  restrictToDays,
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
    intlZone("Europe/Paris", ["2026-09-28", "2026-09-29", "2026-09-30"]),
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
  const axis = buildAxis(days, intlZone("Europe/Paris", days));
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
  const axis = buildAxis(days, intlZone("Europe/Paris", days));
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
  const axis = buildAxis(days, intlZone("Africa/Cairo", days));
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

describe("Africa/Cairo — axis labels", () => {
  const axis = buildAxis(
    ["2026-10-28", "2026-10-29", "2026-10-30"],
    intlZone("Africa/Cairo", ["2026-10-28", "2026-10-29", "2026-10-30"]),
  );

  it("never draws two labels at the same height", () => {
    const ys = axis.marks.map((mark) => mark.y);
    expect(new Set(ys).size).toBe(ys.length);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("labels 1440 only as the second 23:00, never as the next midnight", () => {
    expect(axis.marks.filter((mark) => mark.y >= 1380)).toEqual([
      { y: 1380, label: "23:00", repeated: false },
      { y: 1440, label: "23:00", repeated: true },
    ]);
    expect(axis.marks.filter((mark) => mark.label === "00:00")).toEqual([
      { y: 0, label: "00:00", repeated: false },
    ]);
  });
});

// Cuba: on 1 Nov 2026 the clocks go back at 01:00 EDT to 00:00 EST, so the
// local midnight itself happens twice (04:00Z and 05:00Z). On 8 Mar 2026
// they go forward at 00:00 EST to 01:00 EDT: midnight never happens.
describe("America/Havana — repeated midnight (1 Nov 2026)", () => {
  const TZ_HAVANA = "America/Havana";
  const days = ["2026-10-31", "2026-11-01", "2026-11-02"];
  const axis = buildAxis(days, intlZone(TZ_HAVANA, days));
  const DST = "2026-11-01";
  const at = (startsAt: string, endsAt: string) =>
    block({ timeZone: TZ_HAVANA, startsAt, endsAt });
  const onlyOn = (item: { startsAt: string; endsAt: string }, date: string) => {
    for (const other of days.filter((day) => day !== date)) {
      expect(segmentOn(axis, item, other)).toBeNull();
    }
  };

  it("starts the day at the FIRST midnight and ends it at the next one", () => {
    expect(intlDayBounds(DST, TZ_HAVANA)).toEqual({
      startMs: Date.parse("2026-11-01T04:00:00Z"),
      endMs: Date.parse("2026-11-02T05:00:00Z"),
    });
    expect(intlDayBounds("2026-10-31", TZ_HAVANA)).toEqual({
      startMs: Date.parse("2026-10-31T04:00:00Z"),
      endMs: Date.parse("2026-11-01T04:00:00Z"),
    });
    expect(axis.band).toEqual({ date: DST, start: 0, end: 60 });
    expect(axis.frames.get(DST)).toMatchObject({ endY: 1500, gaps: [] });
    expect(axis.frames.get("2026-10-31")).toMatchObject({
      endY: 1500,
      gaps: [{ top: 60, bottom: 120 }],
    });
    expect(axis.marks.slice(0, 3)).toEqual([
      { y: 0, label: "00:00", repeated: false },
      { y: 60, label: "00:00", repeated: true },
      { y: 120, label: "01:00", repeated: false },
    ]);
  });

  it("first 00:15 → 00:45 (04:15Z → 04:45Z): only on 1 Nov, 30 real minutes at the first 00:15", () => {
    const first = at("2026-11-01T04:15:00.000Z", "2026-11-01T04:45:00.000Z");
    expect(first.localStartsAt).toBe("2026-11-01T00:15");
    expect(first.startOccurrence).toBe("first");
    const segment = segmentOn(axis, first, DST);
    expect(segment).toMatchObject({
      top: 15,
      bottom: 45,
      pieces: [{ top: 15, bottom: 45 }],
      continuesBefore: false,
      continuesAfter: false,
    });
    expect(total(segment)).toBe(30);
    onlyOn(first, DST);
    expect(timeAt(axis, DST, 15)).toBe("00:15");
  });

  it("second 00:15 → 00:45 (05:15Z → 05:45Z) sits one real hour lower", () => {
    const second = at("2026-11-01T05:15:00.000Z", "2026-11-01T05:45:00.000Z");
    expect(second.localStartsAt).toBe("2026-11-01T00:15");
    expect(second.startOccurrence).toBe("second");
    expect(segmentOn(axis, second, DST)).toMatchObject({
      top: 75,
      bottom: 105,
      pieces: [{ top: 75, bottom: 105 }],
    });
    onlyOn(second, DST);
    expect(timeAt(axis, DST, 75)).toBe("00:15");
  });

  it("first midnight → second midnight is one real hour on 1 Nov only", () => {
    const hour = at("2026-11-01T04:00:00.000Z", "2026-11-01T05:00:00.000Z");
    expect(segmentOn(axis, hour, DST)).toMatchObject({ top: 0, bottom: 60 });
    onlyOn(hour, DST);
  });

  it("an event crossing both midnights keeps its real two hours over two days", () => {
    // 31 Oct 23:30 EDT (03:30Z) → 1 Nov 00:30 EST (05:30Z).
    const crossing = at("2026-11-01T03:30:00.000Z", "2026-11-01T05:30:00.000Z");
    const before = segmentOn(axis, crossing, "2026-10-31");
    const after = segmentOn(axis, crossing, DST);
    expect(before).toMatchObject({
      top: 1470,
      bottom: 1500,
      continuesAfter: true,
    });
    expect(after).toMatchObject({
      top: 0,
      bottom: 90,
      continuesBefore: true,
      continuesAfter: false,
    });
    expect(total(before) + total(after)).toBe(120);
    expect(segmentOn(axis, crossing, "2026-11-02")).toBeNull();
  });

  it("half-open days: ending at the first midnight stays on 31 Oct, starting at it is 1 Nov", () => {
    const lastHour = at("2026-11-01T03:00:00.000Z", "2026-11-01T04:00:00.000Z");
    expect(segmentOn(axis, lastHour, "2026-10-31")).toMatchObject({
      top: 1440,
      bottom: 1500,
      continuesAfter: false,
    });
    onlyOn(lastHour, "2026-10-31");
    const lastOfDst = at(
      "2026-11-02T04:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
    );
    expect(segmentOn(axis, lastOfDst, DST)).toMatchObject({
      top: 1440,
      bottom: 1500,
      continuesAfter: false,
    });
    onlyOn(lastOfDst, DST);
  });

  it("a whole-day closure covers the 25 h day exactly", () => {
    const closure = at("2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z");
    expect(coversWholeDay(axis, closure, DST)).toBe(true);
    expect(allDayBlocks(axis, [closure], "2026-10-31")).toEqual([]);
    expect(allDayBlocks(axis, [closure], "2026-11-02")).toEqual([]);
  });
});

describe("America/Havana — skipped midnight (8 Mar 2026)", () => {
  const TZ_HAVANA = "America/Havana";
  const days = ["2026-03-07", "2026-03-08", "2026-03-09"];
  const axis = buildAxis(days, intlZone(TZ_HAVANA, days));

  it("starts the day at the transition (01:00 EDT) and shows 00:00–01:00 as a strip", () => {
    expect(intlDayBounds("2026-03-08", TZ_HAVANA)).toEqual({
      startMs: Date.parse("2026-03-08T05:00:00Z"),
      endMs: Date.parse("2026-03-09T04:00:00Z"),
    });
    expect(axis.band).toBeNull();
    expect(axis.frames.get("2026-03-08")).toMatchObject({
      skipped: { top: 0, bottom: 60 },
      gaps: [{ top: 0, bottom: 60 }],
    });
  });

  it("an event over the missing midnight is split over both days, worth its real hour", () => {
    const night = block({
      timeZone: TZ_HAVANA,
      startsAt: "2026-03-08T04:30:00.000Z", // 7 Mar 23:30 EST
      endsAt: "2026-03-08T05:30:00.000Z", // 8 Mar 01:30 EDT
    });
    const before = segmentOn(axis, night, "2026-03-07");
    const after = segmentOn(axis, night, "2026-03-08");
    expect(before).toMatchObject({ top: 1410, bottom: 1440 });
    expect(after).toMatchObject({ pieces: [{ top: 60, bottom: 90 }] });
    expect(total(before) + total(after)).toBe(60);
    expect(segmentOn(axis, night, "2026-03-09")).toBeNull();
  });
});

// Real bounds of local days, written as explicit UTC instants (from the IANA
// rules), for normal days and every kind of transition.
const boundaryCases: {
  zone: string;
  date: string;
  start: string;
  end: string;
  hours: number;
}[] = [
  // Normal days.
  {
    zone: "Europe/Paris",
    date: "2026-09-29",
    start: "2026-09-28T22:00Z",
    end: "2026-09-29T22:00Z",
    hours: 24,
  },
  {
    zone: "Asia/Kathmandu",
    date: "2026-09-29",
    start: "2026-09-28T18:15Z",
    end: "2026-09-29T18:15Z",
    hours: 24,
  },
  // Transitions at 02:00 / 03:00 (Paris): 23 h and 25 h.
  {
    zone: "Europe/Paris",
    date: "2026-03-29",
    start: "2026-03-28T23:00Z",
    end: "2026-03-29T22:00Z",
    hours: 23,
  },
  {
    zone: "Europe/Paris",
    date: "2026-10-25",
    start: "2026-10-24T22:00Z",
    end: "2026-10-25T23:00Z",
    hours: 25,
  },
  // Repeated midnight / skipped midnight (Havana, Santiago, Beirut).
  {
    zone: "America/Havana",
    date: "2026-11-01",
    start: "2026-11-01T04:00Z",
    end: "2026-11-02T05:00Z",
    hours: 25,
  },
  {
    zone: "America/Havana",
    date: "2026-03-08",
    start: "2026-03-08T05:00Z",
    end: "2026-03-09T04:00Z",
    hours: 23,
  },
  {
    zone: "America/Santiago",
    date: "2026-09-06",
    start: "2026-09-06T04:00Z",
    end: "2026-09-07T03:00Z",
    hours: 23,
  },
  {
    zone: "Asia/Beirut",
    date: "2026-03-29",
    start: "2026-03-28T22:00Z",
    end: "2026-03-29T21:00Z",
    hours: 23,
  },
  // Clocks back at 24:00 → 23:00 (the 23:00 hour repeats at the day's end).
  {
    zone: "Africa/Cairo",
    date: "2026-10-29",
    start: "2026-10-28T21:00Z",
    end: "2026-10-29T22:00Z",
    hours: 25,
  },
  {
    zone: "America/Santiago",
    date: "2026-04-04",
    start: "2026-04-04T03:00Z",
    end: "2026-04-05T04:00Z",
    hours: 25,
  },
  {
    zone: "Asia/Beirut",
    date: "2026-10-24",
    start: "2026-10-23T21:00Z",
    end: "2026-10-24T22:00Z",
    hours: 25,
  },
  // 30-minute shifts (Lord Howe): 24.5 h and 23.5 h days.
  {
    zone: "Australia/Lord_Howe",
    date: "2026-04-05",
    start: "2026-04-04T13:00Z",
    end: "2026-04-05T13:30Z",
    hours: 24.5,
  },
  {
    zone: "Australia/Lord_Howe",
    date: "2026-10-04",
    start: "2026-10-03T13:30Z",
    end: "2026-10-04T13:00Z",
    hours: 23.5,
  },
  // Two-hour shifts (Troll): 22 h and 26 h days.
  {
    zone: "Antarctica/Troll",
    date: "2026-03-29",
    start: "2026-03-29T00:00Z",
    end: "2026-03-29T22:00Z",
    hours: 22,
  },
  {
    zone: "Antarctica/Troll",
    date: "2026-10-25",
    start: "2026-10-24T22:00Z",
    end: "2026-10-26T00:00Z",
    hours: 26,
  },
  // Jump from 23:00 to the next midnight (Nuuk): the transition IS the day's end.
  {
    zone: "America/Nuuk",
    date: "2026-03-28",
    start: "2026-03-28T02:00Z",
    end: "2026-03-29T01:00Z",
    hours: 23,
  },
  // A date that never happened (Samoa skipped 30 Dec 2011): an empty day.
  {
    zone: "Pacific/Apia",
    date: "2011-12-29",
    start: "2011-12-29T10:00Z",
    end: "2011-12-30T10:00Z",
    hours: 24,
  },
  {
    zone: "Pacific/Apia",
    date: "2011-12-30",
    start: "2011-12-30T10:00Z",
    end: "2011-12-30T10:00Z",
    hours: 0,
  },
  {
    zone: "Pacific/Apia",
    date: "2011-12-31",
    start: "2011-12-30T10:00Z",
    end: "2011-12-31T10:00Z",
    hours: 24,
  },
];

describe("America/Nuuk — clocks jump from 23:00 to 00:00 (28 Mar 2026)", () => {
  const TZ_NUUK = "America/Nuuk";
  const days = ["2026-03-27", "2026-03-28", "2026-03-29"];
  const axis = buildAxis(days, intlZone(TZ_NUUK, days));

  it("shows the skipped 23:00–24:00 at the end of the day, not at midnight", () => {
    expect(axis.frames.get("2026-03-28")).toMatchObject({
      skipped: { top: 1380, bottom: 1440 },
      gaps: [{ top: 1380, bottom: 1440 }],
    });
    expect(axis.frames.get("2026-03-29")?.gaps).toEqual([]);
    expect(timeAt(axis, "2026-03-28", 1390)).toBeNull();
    expect(timeAt(axis, "2026-03-28", 30)).toBe("00:30");
  });

  it("an event over the jump keeps its real hour, drawn around the strip", () => {
    const night = block({
      timeZone: TZ_NUUK,
      startsAt: "2026-03-29T00:30:00.000Z", // Sat 22:30 (UTC−2)
      endsAt: "2026-03-29T01:30:00.000Z", // Sun 00:30 (UTC−1)
    });
    const before = segmentOn(axis, night, "2026-03-28");
    const after = segmentOn(axis, night, "2026-03-29");
    expect(before).toMatchObject({
      pieces: [{ top: 1350, bottom: 1380 }],
      continuesAfter: true,
    });
    expect(after).toMatchObject({ pieces: [{ top: 0, bottom: 30 }] });
    expect(total(before) + total(after)).toBe(60);
    expect(segmentOn(axis, night, "2026-03-27")).toBeNull();
  });
});

describe("localDayBounds — explicit UTC bounds in many IANA zones", () => {
  it.each(boundaryCases)(
    "$zone $date: [$start, $end) = $hours h",
    ({ zone, date, start, end, hours }) => {
      const bounds = intlDayBounds(date, zone);
      expect(new Date(bounds.startMs).toISOString()).toBe(
        new Date(start).toISOString(),
      );
      expect(new Date(bounds.endMs).toISOString()).toBe(
        new Date(end).toISOString(),
      );
      expect((bounds.endMs - bounds.startMs) / 3_600_000).toBe(hours);
    },
  );
});

describe("grid invariant — shown on a day if and only if the real periods intersect", () => {
  const MINUTE_MS = 60_000;
  const durations = [15, 30, 45, 60, 90, 150, 24 * 60 + 30];

  it.each(boundaryCases.filter((entry) => entry.hours !== 24))(
    "$zone around $date",
    ({ zone, date }) => {
      const window = ["-1", "0", "1"].map((shift) => {
        const base = new Date(`${date}T12:00:00Z`);
        base.setUTCDate(base.getUTCDate() + Number(shift));
        return base.toISOString().slice(0, 10);
      });
      const axis = buildAxis(window, intlZone(zone, window));
      // Expected bounds come from the explicit table when present.
      const bound = (day: string) => {
        const entry = boundaryCases.find(
          (row) => row.zone === zone && row.date === day,
        );
        return entry
          ? { startMs: Date.parse(entry.start), endMs: Date.parse(entry.end) }
          : intlDayBounds(day, zone);
      };
      const first = bound(window[0]!).startMs;
      const last = bound(window[2]!).endMs;

      for (
        let start = first - 3 * 3_600_000;
        start < last + 3_600_000;
        start += 15 * MINUTE_MS
      ) {
        for (const duration of durations) {
          const item = {
            startsAt: new Date(start).toISOString(),
            endsAt: new Date(start + duration * MINUTE_MS).toISOString(),
          };
          for (const day of window) {
            const { startMs, endMs } = bound(day);
            const overlap =
              Math.min(start + duration * MINUTE_MS, endMs) -
              Math.max(start, startMs);
            const segment = segmentOn(axis, item, day);
            // Half-open [start, end): touching a bound is not intersecting.
            expect(
              segment !== null,
              `${item.startsAt} +${duration} on ${day}`,
            ).toBe(overlap > 0);
            if (!segment) continue;
            const frame = axis.frames.get(day)!;
            for (const piece of segment.pieces) {
              expect(piece.top).toBeGreaterThanOrEqual(0);
              expect(piece.bottom).toBeLessThanOrEqual(frame.endY);
              for (const gap of frame.gaps) {
                expect(piece.bottom <= gap.top || piece.top >= gap.bottom).toBe(
                  true,
                );
              }
            }
            if (overlap >= 15 * MINUTE_MS) {
              expect(total(segment)).toBe(overlap / MINUTE_MS);
            }
          }
        }
      }
    },
  );

  it("labels never collide, whatever the transition", () => {
    for (const { zone, date } of boundaryCases) {
      const week = [-3, -2, -1, 0, 1, 2, 3].map((shift) => {
        const day = new Date(`${date}T12:00:00Z`);
        day.setUTCDate(day.getUTCDate() + shift);
        return day.toISOString().slice(0, 10);
      });
      const ys = buildAxis(week, intlZone(zone, week)).marks.map(
        (mark) => mark.y,
      );
      expect(new Set(ys).size, `${zone} ${date}`).toBe(ys.length);
      expect(ys, `${zone} ${date}`).toEqual([...ys].sort((a, b) => a - b));
    }
  });
});

describe("restrictToDays — the extra day requested is never shown", () => {
  it("keeps the first real hour of a repeated midnight and drops the previous day", () => {
    const TZ_HAVANA = "America/Havana";
    const first = block({
      timeZone: TZ_HAVANA,
      startsAt: "2026-11-01T04:15:00.000Z",
      endsAt: "2026-11-01T04:45:00.000Z",
    });
    const previous = block({
      timeZone: TZ_HAVANA,
      startsAt: "2026-11-01T03:00:00.000Z",
      endsAt: "2026-11-01T04:00:00.000Z",
    });
    const data = agenda("2026-10-31", "2026-11-01", {
      blocks: [first, previous],
      timeZone: TZ_HAVANA,
    });
    const visible = restrictToDays(data, ["2026-11-01"]);
    expect(visible.blocks.map((item) => item.id)).toEqual([first.id]);
    expect(visible.workingHours.days.map((day) => day.date)).toEqual([
      "2026-11-01",
    ]);
  });
});
