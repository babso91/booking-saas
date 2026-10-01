import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppSupabaseClient } from "@/lib/supabase/types";

import { readBusinessToday } from "./business-time";

vi.mock("server-only", () => ({}));

// public.business_time as PostgreSQL answers it (migration 20261002090000):
// the date, the instant it ends and the database's own instant, from one
// call. Here PostgreSQL is at 23:50 in Vancouver on 13 March 2027: the date
// lasts ten more minutes.
const POSTGRES = {
  timezone: "America/Vancouver",
  today: "2027-03-13",
  todayEndsAt: "2027-03-14T08:00:00+00:00",
  now: "2027-03-14T07:50:00+00:00",
  days: [],
  locals: [],
  instants: [],
  offsets: [],
};

function postgres(answer: object = POSTGRES) {
  const rpc = vi.fn(async () => ({ data: answer, error: null }));
  return { client: { rpc } as unknown as AppSupabaseClient, rpc };
}

const remaining = (today: { endsAt: string; now: string }) =>
  Date.parse(today.endsAt) - Date.parse(today.now);

afterEach(() => {
  vi.useRealTimers();
});

describe("readBusinessToday", () => {
  it("one round trip: the date, its end and now, all from PostgreSQL", async () => {
    const { client, rpc } = postgres();

    expect(await readBusinessToday(client, "business")).toEqual({
      date: "2027-03-13",
      endsAt: "2027-03-14T08:00:00.000Z",
      now: "2027-03-14T07:50:00.000Z",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "business_time",
      expect.objectContaining({ p_business_id: "business", p_dates: [] }),
    );
  });

  it.each([
    ["on time", "2027-03-14T07:50:00Z"],
    ["24 hours late", "2027-03-13T07:50:00Z"],
    ["24 hours ahead", "2027-03-15T07:50:00Z"],
    ["in 1999", "1999-01-01T00:00:00Z"],
  ])(
    "this server's clock %s: the answer is the same, ten minutes remain",
    async (_label, serverClock) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(serverClock));
      const { client, rpc } = postgres();

      const today = await readBusinessToday(client, "business");
      expect(today).toEqual({
        date: "2027-03-13",
        endsAt: "2027-03-14T08:00:00.000Z",
        now: "2027-03-14T07:50:00.000Z",
      });
      expect(remaining(today)).toBe(10 * 60_000);
      // Nothing derived from this server's date is sent either.
      expect(rpc.mock.calls[0]).toEqual([
        "business_time",
        {
          p_business_id: "business",
          p_dates: [],
          p_locals: [],
          p_instants: [],
          p_open_ranges: false,
        },
      ]);
    },
  );

  it("a database without the migration: an internal error, never this server's clock instead", async () => {
    const { todayEndsAt: _end, now: _now, ...old } = POSTGRES;
    void _end;
    void _now;
    await expect(
      readBusinessToday(postgres(old).client, "business"),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(
      readBusinessToday(
        postgres({ ...old, todayEndsAt: POSTGRES.todayEndsAt }).client,
        "business",
      ),
    ).rejects.toMatchObject({ code: "internal" });
  });
});
