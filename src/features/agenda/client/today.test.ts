import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  anchored,
  elapsedSince,
  MIN_REMAINING_MS,
  msUntilEnd,
  retryDelay,
  unverified,
} from "./today";

const ms = (value: string) => Date.parse(value);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// PostgreSQL: Thursday 1 Oct 2026 in Europe/Paris ends at 22:00Z. The server
// answered at 21:50Z: the date lasts ten more minutes.
const answer = {
  date: "2026-10-01",
  endsAt: "2026-10-01T22:00:00.000Z",
  now: "2026-10-01T21:50:00.000Z",
};

describe("how long the known date lasts", () => {
  it("is what the server said (endsAt − its own now), from the moment the question was sent", () => {
    const known = anchored(answer, { mono: 1_000, wall: 5_000 });
    expect(known).toEqual({
      date: "2026-10-01",
      remainingMs: 10 * MINUTE,
      sent: { mono: 1_000, wall: 5_000 },
    });
  });

  it.each([
    ["on time", ms("2026-10-01T21:50:00Z")],
    ["10 minutes late", ms("2026-10-01T21:40:00Z")],
    ["2 hours late", ms("2026-10-01T19:50:00Z")],
    ["10 minutes ahead", ms("2026-10-01T22:00:00Z")],
    ["2 hours ahead", ms("2026-10-01T23:50:00Z")],
    ["in 1999", ms("1999-01-01T00:00:00Z")],
  ])("does not depend on the device wall clock (%s)", (_label, wall) => {
    const known = anchored(answer, { mono: 0, wall });
    const after = (elapsed: number) =>
      msUntilEnd(known, { mono: elapsed, wall: wall + elapsed });

    expect(after(0)).toBe(10 * MINUTE);
    expect(after(9 * MINUTE + 59_000)).toBe(1_000);
    expect(after(10 * MINUTE)).toBe(0);
    expect(after(3 * HOUR)).toBeLessThan(0);
  });

  it("is never compared with the device's date: an unverified date has no end here", () => {
    expect(msUntilEnd(unverified("2026-10-01"), { mono: 0, wall: 0 })).toBe(
      null,
    );
  });

  it("small clock difference between the server and PostgreSQL: a short floor, not minutes", () => {
    // The server stamps 22:00:00.300Z on an answer PostgreSQL computed just
    // before midnight.
    const known = anchored(
      { ...answer, now: "2026-10-01T22:00:00.300Z" },
      { mono: 0, wall: 0 },
    );
    expect(known.remainingMs).toBe(MIN_REMAINING_MS);
    expect(MIN_REMAINING_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("elapsed time on the device", () => {
  const sent = { mono: 10_000, wall: ms("2026-10-01T21:50:00Z") };

  it("normal: both readings agree", () => {
    expect(elapsedSince(sent, { mono: 70_000, wall: sent.wall + 60_000 })).toBe(
      60_000,
    );
  });

  it("sleep: the monotonic clock paused, the wall clock shows the night", () => {
    expect(
      elapsedSince(sent, { mono: 10_500, wall: sent.wall + 9 * HOUR }),
    ).toBe(9 * HOUR);
  });

  it("clock set back by hand while open: the monotonic clock still counts", () => {
    expect(
      elapsedSince(sent, {
        mono: 10_000 + 20 * MINUTE,
        wall: sent.wall - HOUR,
      }),
    ).toBe(20 * MINUTE);
  });

  it("clock set forward by hand: only asks again early", () => {
    const known = anchored(answer, sent);
    expect(
      msUntilEnd(known, { mono: 11_000, wall: sent.wall + 2 * HOUR }),
    ).toBeLessThan(0);
  });
});

describe("retry delay after failures", () => {
  it("grows and stays bounded: never an aggressive loop", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryDelay)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
  });
});

describe("PostgreSQL stays the only calendar authority", () => {
  const code = (file: string) =>
    readFileSync(join(__dirname, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join("\n");

  it("no time zone API and no date arithmetic in the refresh of today", () => {
    for (const file of [
      "today.ts",
      "today-tracker.ts",
      "use-canonical-today.ts",
    ]) {
      expect(code(file), file).not.toMatch(
        /\bIntl\b|toLocale|getTimezoneOffset|timeZone|lib\/time\/(zoned|local-date)|\.(get|set)(UTC)?(Hours|Date|Day|Month|FullYear)\(/,
      );
    }
  });

  it("the device clock is read for durations only, never against a server instant", () => {
    // `endsAt` and `now` (server instants) meet in one place: their
    // difference. Date.now() / performance.now() only feed elapsed time.
    expect(code("today.ts").match(/endsAt/g)).toHaveLength(1);
    expect(code("today.ts")).toMatch(
      /Date\.parse\(today\.endsAt\) - Date\.parse\(today\.now\)/,
    );
    expect(code("today.ts")).not.toMatch(/Date\.now|performance\.now/);
    expect(code("today-tracker.ts")).not.toMatch(/endsAt|Date\.parse/);
  });
});
