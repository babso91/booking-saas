import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  freshUntil,
  isFresh,
  knownFrom,
  knownFromAgenda,
  retryDelay,
  SKEW_TRUST_MS,
} from "./today";

const ms = (value: string) => Date.parse(value);

// Tuesday 29 Sept 2026 in Europe/Paris ends at 22:00Z.
const tuesday = { date: "2026-09-29", endsAt: "2026-09-29T22:00:00.000Z" };

describe("freshness of the known date", () => {
  it("is fresh until the instant PostgreSQL said the date ends, then stale", () => {
    const known = knownFrom(tuesday, null);
    expect(known).toEqual({
      date: "2026-09-29",
      endsAt: ms("2026-09-29T22:00:00Z"),
      receivedAt: null,
    });
    expect(isFresh(known, ms("2026-09-29T08:00:00Z"))).toBe(true);
    expect(isFresh(known, ms("2026-09-29T21:59:59.999Z"))).toBe(true);
    expect(isFresh(known, ms("2026-09-29T22:00:00Z"))).toBe(false);
    expect(isFresh(known, ms("2026-10-01T10:00:00Z"))).toBe(false);
  });

  it("a date without its end is stale at once: its bounds must be asked", () => {
    const known = { date: "2026-09-30", endsAt: null, receivedAt: 1_000 };
    expect(isFresh(known, 1_000)).toBe(false);
  });

  it("device clock ahead of the server: the answer is trusted for a bounded time, not asked in a loop", () => {
    // PostgreSQL still says Tuesday although the device believes it is
    // Wednesday 10:00Z.
    const receivedAt = ms("2026-09-30T10:00:00Z");
    const known = knownFrom(tuesday, receivedAt);
    expect(freshUntil(known)).toBe(receivedAt + SKEW_TRUST_MS);
    expect(isFresh(known, receivedAt + 1)).toBe(true);
    expect(isFresh(known, receivedAt + SKEW_TRUST_MS)).toBe(false);
  });
});

describe("what an agenda read says about today", () => {
  const current = knownFrom(tuesday, null);
  const day = (date: string, endsAt: string) => ({ date, endsAt });

  it("takes the date and its end when today is one of the days read", () => {
    expect(
      knownFromAgenda(
        {
          today: "2026-09-30",
          workingHours: {
            days: [
              day("2026-09-29", "2026-09-29T22:00:00.000Z"),
              day("2026-09-30", "2026-09-30T22:00:00.000Z"),
            ],
          },
        },
        current,
        5,
      ),
    ).toEqual({
      date: "2026-09-30",
      endsAt: ms("2026-09-30T22:00:00Z"),
      receivedAt: 5,
    });
  });

  it("adds nothing when another week is read and the date is unchanged", () => {
    expect(
      knownFromAgenda(
        {
          today: "2026-09-29",
          workingHours: {
            days: [day("2026-10-05", "2026-10-05T22:00:00.000Z")],
          },
        },
        current,
        5,
      ),
    ).toBeNull();
  });

  it("a new date read with another week is kept, stale until its end is known", () => {
    const next = knownFromAgenda(
      {
        today: "2026-09-30",
        workingHours: { days: [day("2026-10-05", "2026-10-05T22:00:00.000Z")] },
      },
      current,
      5,
    );
    expect(next).toEqual({ date: "2026-09-30", endsAt: null, receivedAt: 5 });
    expect(isFresh(next!, 5)).toBe(false);
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
  it("the refresh of today uses no time zone API and no date arithmetic", () => {
    for (const file of ["today.ts", "use-canonical-today.ts"]) {
      const code = readFileSync(join(__dirname, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(
        /\bIntl\b|toLocale|getTimezoneOffset|timeZone|lib\/time\/(zoned|local-date)|\.(get|set)(UTC)?(Hours|Date|Day|Month|FullYear)\(/,
      );
    }
  });
});
