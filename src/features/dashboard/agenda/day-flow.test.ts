import { describe, expect, it } from "vitest";

import type {
  AgendaAppointmentDto,
  AgendaBlockDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";

import {
  SAMPLE_TODAY,
  sampleBusyWeek,
  sampleInstant,
  sampleNightWeek,
  sampleTrainingWeek,
  sampleWeek,
} from "../fixtures/sample-week";
import {
  dayFlow,
  distinctBookings,
  overlappingVisits,
  type FlowVisit,
} from "./day-flow";

const at = (time: string, date = SAMPLE_TODAY) =>
  Date.parse(sampleInstant(date, time));

const kinds = (flow: ReturnType<typeof dayFlow>) =>
  flow.items.map((item) =>
    item.kind === "visits"
      ? `visits:${item.visits.map((v) => v.appointment.client.displayName.split(" ")[0]).join("+")}`
      : item.kind === "free"
        ? `free:${item.time}+${item.minutes}${item.ahead ? "" : "(past)"}`
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
      ahead: true,
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

// ——— ST2-002, ST2-003, ST2-004: one tailored day, Paris UTC+1 unless said ———

const MONDAY = "2026-10-26";

function visit(
  id: string,
  start: string,
  end: string,
  extra: Partial<AgendaAppointmentDto> = {},
): AgendaAppointmentDto {
  return {
    ...sampleWeek.appointments[0]!,
    id,
    startsAt: start,
    endsAt: end,
    localStartsAt: "2026-10-26T00:00",
    localEndsAt: "2026-10-26T00:00",
    bufferMinutes: 0,
    status: "confirmed",
    ...extra,
  };
}

function tailored(
  openings: [start: string, end: string][],
  appointments: AgendaAppointmentDto[],
  blocks: AgendaBlockDto[] = [],
): AgendaDto {
  const days = sampleWeek.workingHours.days.map((day) =>
    day.date === MONDAY
      ? {
          ...day,
          openRanges: openings.map(([startsAt, endsAt]) => ({
            startsAt,
            endsAt,
            localStartsAt: "",
            localEndsAt: "",
          })),
        }
      : day,
  );
  return {
    ...sampleWeek,
    appointments,
    blocks,
    workingHours: { ...sampleWeek.workingHours, days },
  };
}

const m = (time: string, date = MONDAY) => sampleInstant(date, time);
const before = (time: string) => m(time, "2026-10-25");

const free = (flow: ReturnType<typeof dayFlow>) =>
  flow.items.flatMap((item) =>
    item.kind === "free"
      ? [`${item.time}+${item.minutes}${item.ahead ? "" : "(past)"}`]
      : [],
  );

describe("dayFlow — the buffer holds time (ST2-002)", () => {
  const morning: [string, string] = [m("09:00"), m("11:00")];

  it("free only after the buffer: 09–11, visit 09–10, buffer 30 → 10:30 + 30", () => {
    const flow = dayFlow(
      tailored(
        [morning],
        [visit("a", m("09:00"), m("10:00"), { bufferMinutes: 30 })],
      ),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual(["10:30+30"]);
    expect(flow.freeMinutes).toBe(30);
  });

  it("no buffer: free right after the visit", () => {
    const flow = dayFlow(
      tailored([morning], [visit("a", m("09:00"), m("10:00"))]),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual(["10:00+60"]);
  });

  it("a cancelled visit holds neither its time nor its buffer", () => {
    const flow = dayFlow(
      tailored(
        [morning],
        [
          visit("a", m("09:00"), m("10:00"), {
            bufferMinutes: 30,
            status: "cancelled",
          }),
        ],
      ),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual(["09:00+120"]);
  });

  it("completed and no-show visits keep theirs, as the database does", () => {
    for (const status of ["completed", "no_show"] as const) {
      const flow = dayFlow(
        tailored(
          [morning],
          [visit("a", m("09:00"), m("10:00"), { bufferMinutes: 30, status })],
        ),
        MONDAY,
        null,
      );
      expect(free(flow), status).toEqual(["10:30+30"]);
    }
  });

  it("a buffer may end past closing, into a pause or the next visit", () => {
    const flow = dayFlow(
      tailored(
        [[m("09:00"), m("12:00")]],
        [
          visit("a", m("09:00"), m("10:00"), { bufferMinutes: 15 }),
          visit("b", m("10:10"), m("11:45"), { bufferMinutes: 60 }),
        ],
      ),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual([]);
    expect(flow.freeMinutes).toBe(0);
  });

  it("across midnight: yesterday's buffer holds the start of the day, without a visit on it", () => {
    const flow = dayFlow(
      tailored(
        [[m("00:00"), m("01:00")]],
        [visit("a", before("23:00"), before("23:50"), { bufferMinutes: 30 })],
      ),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual(["00:20+40"]);
    expect(flow.count).toBe(0);
  });

  it("a visit itself across midnight: its buffer counts on the next day only", () => {
    const flow = dayFlow(
      tailored(
        [[m("00:00"), m("02:00")]],
        [visit("a", before("23:30"), m("00:30"), { bufferMinutes: 30 })],
      ),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual(["01:00+60"]);
    expect(flow.count).toBe(1);
  });

  it("a buffer past midnight is cut at the end of its own day", () => {
    const flow = dayFlow(
      tailored(
        [[m("22:00"), m("00:00", "2026-10-27")]],
        [visit("a", m("22:00"), m("23:50"), { bufferMinutes: 30 })],
      ),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual([]);
  });

  it("the repeated autumn hour: the buffer is real minutes, not wall-clock ones", () => {
    // Sunday 25 October 2026, Paris: 03:00 CEST (01:00Z) becomes 02:00 CET.
    const date = "2026-10-25";
    const data: AgendaDto = {
      ...sampleWeek,
      offsets: [
        {
          startsAt: "2026-10-24T22:00:00.000Z",
          endsAt: "2026-10-25T01:00:00.000Z",
          offsetSeconds: 7200,
        },
        {
          startsAt: "2026-10-25T01:00:00.000Z",
          endsAt: "2026-10-25T23:00:00.000Z",
          offsetSeconds: 3600,
        },
      ],
      appointments: [
        // 02:10–02:40 summer time, 30 minutes held: until 02:10 winter time.
        visit("a", "2026-10-25T00:10:00.000Z", "2026-10-25T00:40:00.000Z", {
          bufferMinutes: 30,
        }),
      ],
      blocks: [],
      workingHours: {
        weekly: [],
        days: [
          {
            date,
            weekday: 0,
            startsAt: "2026-10-24T22:00:00.000Z",
            endsAt: "2026-10-25T23:00:00.000Z",
            openRanges: [
              {
                startsAt: "2026-10-25T00:00:00.000Z",
                endsAt: "2026-10-25T02:00:00.000Z",
                localStartsAt: "",
                localEndsAt: "",
              },
            ],
          },
        ],
      },
    };
    const flow = dayFlow(data, date, null);
    expect(free(flow)).toEqual(["02:00+10", "02:10+50"]);
    expect(flow.freeMinutes).toBe(60);
    const starts = flow.items.flatMap((item) =>
      item.kind === "free" ? [new Date(item.start).toISOString()] : [],
    );
    expect(starts).toEqual([
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T01:10:00.000Z",
    ]);
  });
});

describe("dayFlow — small free time (ST2-003)", () => {
  it("ten free minutes are counted and offered: a service can last five", () => {
    const flow = dayFlow(
      tailored(
        [[m("09:00"), m("10:00")]],
        [visit("a", m("09:00"), m("09:50"))],
      ),
      MONDAY,
      null,
    );
    expect(free(flow)).toEqual(["09:50+10"]);
    expect(flow.freeMinutes).toBe(10);
  });

  it("five minutes are offered; under that, counted but not offered", () => {
    const five = dayFlow(
      tailored(
        [[m("09:00"), m("10:00")]],
        [visit("a", m("09:00"), m("09:55"))],
      ),
      MONDAY,
      null,
    );
    expect(free(five)).toEqual(["09:55+5"]);

    const three = dayFlow(
      tailored(
        [[m("09:00"), m("10:00")]],
        [visit("a", m("09:00"), m("09:57"))],
      ),
      MONDAY,
      null,
    );
    expect(free(three)).toEqual([]);
    expect(three.freeMinutes).toBe(3);
  });

  it("the total adds every stretch still ahead, nothing already behind", () => {
    const flow = dayFlow(
      tailored(
        [[m("09:00"), m("12:00")]],
        [
          visit("a", m("09:30"), m("10:00")),
          visit("b", m("10:03"), m("11:50")),
        ],
      ),
      MONDAY,
      Date.parse(m("09:45")),
    );
    expect(free(flow)).toEqual(["09:00+30(past)", "11:50+10"]);
    expect(flow.freeMinutes).toBe(13);
  });

  it("a stretch begun and nearly over offers nothing and never goes negative", () => {
    const flow = dayFlow(
      tailored(
        [[m("09:00"), m("10:02")]],
        [visit("a", m("09:00"), m("10:00"))],
      ),
      MONDAY,
      Date.parse(m("10:01")),
    );
    expect(free(flow)).toEqual([]);
    expect(flow.freeMinutes).toBe(0);
  });
});

describe("dayFlow — the « now » marker (ST2-004)", () => {
  const now = Date.parse(m("09:30"));
  const nowItems = (flow: ReturnType<typeof dayFlow>) =>
    flow.items.filter((item) => item.kind === "now").length;

  it("a cancelled visit shown across now does not hide it", () => {
    const flow = dayFlow(
      tailored(
        [[m("09:00"), m("11:00")]],
        [visit("a", m("09:00"), m("10:00"), { status: "cancelled" })],
      ),
      MONDAY,
      now,
    );
    expect(kinds(flow)).toEqual(["visits:Amel", "now:09:30", "free:09:30+90"]);
    expect(nowItems(flow)).toBe(1);
  });

  it("the same visit not read (cancelled hidden): the marker is there too", () => {
    const flow = dayFlow(tailored([[m("09:00"), m("11:00")]], []), MONDAY, now);
    expect(nowItems(flow)).toBe(1);
  });

  it("a completed or no-show visit is not going on: the marker stays", () => {
    for (const status of ["completed", "no_show"] as const) {
      const flow = dayFlow(
        tailored(
          [[m("09:00"), m("11:00")]],
          [visit("a", m("09:00"), m("10:00"), { status })],
        ),
        MONDAY,
        now,
      );
      expect(nowItems(flow), status).toBe(1);
    }
  });

  it("a confirmed visit going on says it itself, even beside a cancelled one", () => {
    const flow = dayFlow(
      tailored(
        [[m("09:00"), m("11:00")]],
        [
          visit("a", m("09:00"), m("10:00"), { status: "cancelled" }),
          visit("b", m("09:15"), m("10:00")),
        ],
      ),
      MONDAY,
      now,
    );
    expect(nowItems(flow)).toBe(0);
  });
});

describe("overlappingVisits — what the row can truthfully say", () => {
  const visit = (start: number, end: number, status = "confirmed") =>
    ({ start, end, appointment: { status } }) as unknown as FlowVisit;
  const H = 3_600_000;

  it("two, and three, really at the same time", () => {
    expect(
      overlappingVisits([visit(9 * H, 10 * H), visit(9 * H, 10 * H)]),
    ).toBe(2);
    expect(
      overlappingVisits([
        visit(9 * H, 11 * H),
        visit(9 * H, 11 * H),
        visit(10 * H, 12 * H),
      ]),
    ).toBe(3);
  });

  it("three in a chain: all three overlap another, though never all at once", () => {
    expect(
      overlappingVisits([
        visit(9 * H, 11 * H),
        visit(10 * H, 13 * H),
        visit(12 * H, 14 * H),
      ]),
    ).toBe(3);
  });

  it("touching at the boundary is not overlapping", () => {
    expect(
      overlappingVisits([visit(9 * H, 10 * H), visit(10 * H, 11 * H)]),
    ).toBe(0);
  });

  it("a cancelled visit overlaps nothing, nor does it link two others", () => {
    expect(
      overlappingVisits([
        visit(9 * H, 10 * H),
        visit(9 * H, 10 * H, "cancelled"),
      ]),
    ).toBe(0);
    expect(
      overlappingVisits([
        visit(9 * H, 11 * H),
        visit(10 * H, 13 * H, "cancelled"),
        visit(12 * H, 14 * H),
      ]),
    ).toBe(0);
  });

  it("across midnight: real instants, on the row of each day", () => {
    const tuesday = dayFlow(sampleNightWeek, SAMPLE_TODAY, at("22:00"));
    const night = tuesday.items.at(-1)!;
    expect(night.kind === "visits" && overlappingVisits(night.visits)).toBe(0);
  });
});

describe("dayFlow — free time is cut into stretches", () => {
  it("counts each stretch ahead, however short; past ones count for nothing", () => {
    const flow = dayFlow(sampleWeek, SAMPLE_TODAY, at("14:05"));
    // 14:45, 16:15, 17:15 (15 min each) and 18:30 (30 min), from the items.
    expect(flow.freeMinutes).toBe(75);
    expect(flow.freeStretches).toBe(4);
  });
});
