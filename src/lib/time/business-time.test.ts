import { describe, expect, it, vi } from "vitest";

import type { AppSupabaseClient } from "@/lib/supabase/types";

import { readBusinessToday } from "./business-time";

vi.mock("server-only", () => ({}));

// public.business_time as PostgreSQL answers it, reduced to what the read of
// today uses.
function calendar(today: string, days: { date: string; endsAt: string }[]) {
  return {
    data: {
      timezone: "America/Vancouver",
      today,
      days: days.map((day) => ({
        date: day.date,
        weekday: 0,
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: day.endsAt,
        openRanges: null,
      })),
      locals: [],
      instants: [],
      offsets: [],
    },
    error: null,
  };
}

function clientAnswering(answers: ReturnType<typeof calendar>[]) {
  const rpc = vi.fn();
  answers.forEach((answer) => rpc.mockResolvedValueOnce(answer));
  return { client: { rpc } as unknown as AppSupabaseClient, rpc };
}

describe("readBusinessToday", () => {
  it("returns the date PostgreSQL calls today and the end PostgreSQL gives it", async () => {
    const { client, rpc } = clientAnswering([
      calendar("2027-03-13", []),
      calendar("2027-03-13", [
        { date: "2027-03-13", endsAt: "2027-03-14T08:00:00+00:00" },
      ]),
    ]);

    expect(await readBusinessToday(client, "business")).toEqual({
      date: "2027-03-13",
      endsAt: "2027-03-14T08:00:00.000Z",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_dates: ["2027-03-13"] });
  });

  it("midnight between the two reads: never the end of yesterday with today's date", async () => {
    const { client, rpc } = clientAnswering([
      calendar("2027-03-13", []),
      // The date changed before the bounds were read.
      calendar("2027-03-14", [
        { date: "2027-03-13", endsAt: "2027-03-14T08:00:00+00:00" },
      ]),
      calendar("2027-03-14", [
        { date: "2027-03-14", endsAt: "2027-03-15T07:00:00+00:00" },
      ]),
    ]);

    expect(await readBusinessToday(client, "business")).toEqual({
      date: "2027-03-14",
      endsAt: "2027-03-15T07:00:00.000Z",
    });
    expect(rpc.mock.calls[2]![1]).toMatchObject({ p_dates: ["2027-03-14"] });
  });

  it("gives up with an internal error rather than inventing a date", async () => {
    const { client } = clientAnswering([
      calendar("2027-03-13", []),
      calendar("2027-03-14", []),
      calendar("2027-03-15", []),
      calendar("2027-03-16", []),
    ]);
    await expect(readBusinessToday(client, "business")).rejects.toMatchObject({
      code: "internal",
    });
  });
});
