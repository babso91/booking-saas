import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/public/businesses/[slug]/availability/route";
import type { Database } from "@/types/database.generated";

import {
  createBusiness,
  createProfessional,
  createService,
  dateInDays,
  db,
  env,
  everyDay,
  setWeeklyHours,
  type TestBusiness,
} from "./support/fixtures";

// GET /api/public/businesses/:slug/availability answers slots and the quote
// they are for. Both must come from one read of the catalogue: a change of
// the service between two reads must never give slots for one duration and
// a quote for another.
//
// The public client is the real one, with one twist: its catalogue reads
// run one after the other, and the service's duration changes (30 → 75 min)
// right after the first one. Two independent reads see the change; one
// atomic read does not.

const catalogueReads = new Set([
  "get_available_slots",
  "quote_public_service",
  "get_public_availability",
]);
let afterFirstRead: (() => Promise<void>) | null = null;

vi.mock("@/lib/supabase/public", () => ({
  createPublicSupabaseClient: () => {
    const client = createClient<Database>(env.apiUrl, env.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const rpc = client.rpc.bind(client);
    let gate: Promise<unknown> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rpc = (name: string, ...rest: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder = (rpc as any)(name, ...rest);
      if (!catalogueReads.has(name)) return builder;
      const run = (query: PromiseLike<unknown>) => {
        const done = gate.then(async () => {
          const result = await query;
          const hook = afterFirstRead;
          afterFirstRead = null;
          await hook?.();
          return result;
        });
        gate = done.catch(() => undefined);
        return done;
      };
      return {
        then: (resolve: never, reject: never) =>
          run(builder).then(resolve, reject),
        single: () => ({
          then: (resolve: never, reject: never) =>
            run(builder.single()).then(resolve, reject),
        }),
      };
    };
    return client;
  },
}));

const DATE = dateInDays(16);
let studio: TestBusiness;
let serviceId: string;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  const owner = await createProfessional("snapshot-owner");
  studio = await createBusiness(owner.userId, {
    settings: { slot_interval_minutes: 15, buffer_minutes: 0 },
  });
  await setWeeklyHours(studio.id, everyDay(["09:00", "12:00"]));
  serviceId = await createService(studio.id, {
    durationMinutes: 30,
    priceCents: 3000,
  });
});

async function availability() {
  const url = `http://localhost:3000/api/public/businesses/${studio.slug}/availability?serviceId=${serviceId}&date=${DATE}`;
  const response = await GET(new NextRequest(url), {
    params: Promise.resolve({ slug: studio.slug }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: {
      slots: { startsAt: string; endsAt: string }[];
      quote: { durationMinutes: number; priceCents: number };
    };
  };
}

describe("availability and its quote, from one read", () => {
  it("a change of the service between reads never gives slots and a quote that disagree", async () => {
    afterFirstRead = async () => {
      await db.query(
        "update public.services set duration_minutes = 75, price_cents = 7500 where id = $1",
        [serviceId],
      );
    };
    const { data } = await availability();
    expect(afterFirstRead).toBeNull();
    expect(data.slots.length).toBeGreaterThan(0);
    for (const slot of data.slots) {
      expect(
        (Date.parse(slot.endsAt) - Date.parse(slot.startsAt)) / 60_000,
      ).toBe(data.quote.durationMinutes);
    }
    // The answer is the catalogue before the change, whole.
    expect(data.quote).toMatchObject({ durationMinutes: 30, priceCents: 3000 });

    // The next read sees the change, whole as well.
    const next = await availability();
    expect(next.data.quote).toMatchObject({
      durationMinutes: 75,
      priceCents: 7500,
    });
    for (const slot of next.data.slots) {
      expect(
        (Date.parse(slot.endsAt) - Date.parse(slot.startsAt)) / 60_000,
      ).toBe(75);
    }
  });
});
