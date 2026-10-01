import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSupabaseClient } from "@/lib/supabase/types";

import { readBusinessToday } from "./business-time";

vi.mock("server-only", () => ({}));

// public.business_time as PostgreSQL answers it, reduced to what the read of
// today uses: bounds are returned for the dates asked.
const ENDS: Record<string, string> = {
  "2027-03-13": "2027-03-14T08:00:00+00:00",
  "2027-03-14": "2027-03-15T07:00:00+00:00",
  "2027-03-20": "2027-03-21T07:00:00+00:00",
};

function postgres(todays: string[]) {
  const rpc = vi.fn(async (_name: string, args: { p_dates: string[] }) => ({
    data: {
      timezone: "America/Vancouver",
      today: todays[Math.min(rpc.mock.calls.length - 1, todays.length - 1)],
      days: args.p_dates.map((date) => ({
        date,
        weekday: 0,
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: ENDS[date] ?? "2026-01-02T00:00:00Z",
        openRanges: null,
      })),
      locals: [],
      instants: [],
      offsets: [],
    },
    error: null,
  }));
  return { client: { rpc } as unknown as AppSupabaseClient, rpc };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // The server: 14 March 2027, 03:00Z (still 13 March in Vancouver).
  vi.setSystemTime(new Date("2027-03-14T03:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readBusinessToday", () => {
  it("one round trip: PostgreSQL's date, the end PostgreSQL gives it, the server instant", async () => {
    const { client, rpc } = postgres(["2027-03-13"]);

    expect(await readBusinessToday(client, "business")).toEqual({
      date: "2027-03-13",
      endsAt: "2027-03-14T08:00:00.000Z",
      now: "2027-03-14T03:00:00.000Z",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    // Candidates around the UTC date: a guess about which bounds to fetch.
    expect(rpc.mock.calls[0]![1]).toMatchObject({
      p_dates: ["2027-03-13", "2027-03-14", "2027-03-15"],
    });
  });

  it("the server instant is taken AFTER PostgreSQL answered (never promises more time than there is)", async () => {
    const { client, rpc } = postgres(["2027-03-13"]);
    rpc.mockImplementationOnce(async (_name, args) => {
      vi.setSystemTime(new Date("2027-03-14T03:00:02.000Z")); // a slow answer
      return {
        data: {
          timezone: "America/Vancouver",
          today: "2027-03-13",
          days: args.p_dates.map((date) => ({
            date,
            weekday: 0,
            startsAt: "2026-01-01T00:00:00Z",
            endsAt: ENDS[date] ?? "2026-01-02T00:00:00Z",
            openRanges: null,
          })),
          locals: [],
          instants: [],
          offsets: [],
        },
        error: null,
      };
    });
    expect((await readBusinessToday(client, "business")).now).toBe(
      "2027-03-14T03:00:02.000Z",
    );
  });

  it("the date is PostgreSQL's even when it is none of the candidates: asked again for its bounds", async () => {
    // A server clock (or tzdata) far from the database's.
    const { client, rpc } = postgres(["2027-03-20"]);

    expect(await readBusinessToday(client, "business")).toMatchObject({
      date: "2027-03-20",
      endsAt: "2027-03-21T07:00:00.000Z",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_dates: ["2027-03-20"] });
  });

  it("gives up with an internal error rather than inventing a date", async () => {
    const { client } = postgres([
      "2027-04-01",
      "2027-04-02",
      "2027-04-03",
      "2027-04-04",
    ]);
    await expect(readBusinessToday(client, "business")).rejects.toMatchObject({
      code: "internal",
    });
  });
});
