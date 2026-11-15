import { beforeAll, describe, expect, it, vi } from "vitest";

import { readRetentionAction } from "@/features/retention/actions";
import { readRetentionReport } from "@/features/retention/server/report";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// R4-01 measures: public.crm_retention_report (retention-v1) through the
// user's session and row level security. Visits are arranged directly in
// the database (as postgres), then only read, at a fixed reference instant.

let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));

const AS_OF = "2026-11-14T12:00:00.000Z";

let owner: Professional;
let stranger: Professional;
let business: TestBusiness;
let service: string;
let sequence = 0;

async function newClient() {
  sequence += 1;
  return createClientRecord(business.id, `retour-${sequence}@test.local`);
}

// The agenda refuses overlapping appointments, whatever their status: each
// visit of a UTC day takes the next free hour from 06:00 UTC (still the
// same day in Paris); an explicit time ("…T22:30…") is kept as given.
const nextHour = new Map<string, number>();

async function visit(
  client: string,
  day: string,
  status: "completed" | "no_show" | "cancelled" = "completed",
) {
  let startsAt = day;
  if (!day.includes("T")) {
    const hour = nextHour.get(day) ?? 6;
    nextHour.set(day, hour + 1);
    startsAt = `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  }
  const end = new Date(Date.parse(startsAt) + 60 * 60_000).toISOString();
  await insertAppointment({
    businessId: business.id,
    clientId: client,
    serviceId: service,
    startsAt,
    endsAt: end,
    status,
  });
}

beforeAll(async () => {
  owner = await createProfessional("retention-owner");
  stranger = await createProfessional("retention-stranger");
  business = await createBusiness(owner.userId, { timezone: "Europe/Paris" });
  await createBusiness(stranger.userId);
  service = await createService(business.id);

  // July cohort: 10 new clients on 10 July.
  for (let i = 0; i < 6; i += 1) {
    const c = await newClient();
    await visit(c, "2026-07-10");
    await visit(c, "2026-08-01"); // 22 days: back within 30
  }
  const late = await newClient();
  await visit(late, "2026-07-10");
  await visit(late, "2026-08-20"); // 41 days: within 60 only
  const sameDay = await newClient();
  await visit(sameDay, "2026-07-10");
  await visit(sameDay, "2026-07-10"); // same day: not a return
  for (let i = 0; i < 2; i += 1) {
    await visit(await newClient(), "2026-07-10");
  }

  // September cohort: a no-show in July is never a first visit; 31 August
  // 22:30 UTC is 1 September 00:30 in Paris.
  const noShowFirst = await newClient();
  await visit(noShowFirst, "2026-07-03", "no_show");
  await visit(noShowFirst, "2026-09-15");
  const midnight = await newClient();
  await visit(midnight, "2026-08-31T22:30:00.000Z");

  // October cohort: still being observed on 14 November.
  const back = await newClient();
  await visit(back, "2026-10-20");
  await visit(back, "2026-11-05");
  const notYet = await newClient();
  await visit(notYet, "2026-10-20");
  await visit(notYet, "2026-10-25", "cancelled");

  // Older than the 12 months shown (first month: December 2025).
  const old = await newClient();
  await visit(old, "2025-10-10");
  await visit(old, "2025-10-20");
});

describe("crm_retention_report", () => {
  it("builds the cohorts of the last 12 months in business time (30 days)", async () => {
    const report = await readRetentionReport(
      owner.client,
      { businessId: business.id },
      30,
      AS_OF,
    );
    expect(report).toEqual({
      definitionVersion: "retention-v1",
      windowDays: 30,
      asOf: AS_OF,
      timeZone: "Europe/Paris",
      minCohortSize: 10,
      cohorts: [
        { month: "2026-07", size: 10, returned: 6, fullyObserved: true },
        { month: "2026-09", size: 2, returned: 0, fullyObserved: true },
        { month: "2026-10", size: 2, returned: 1, fullyObserved: false },
      ],
    });
  });

  it("widens the window and observes later (60 days)", async () => {
    const report = await readRetentionReport(
      owner.client,
      { businessId: business.id },
      60,
      AS_OF,
    );
    expect(report.cohorts).toEqual([
      { month: "2026-07", size: 10, returned: 7, fullyObserved: true },
      { month: "2026-09", size: 2, returned: 0, fullyObserved: false },
      { month: "2026-10", size: 2, returned: 1, fullyObserved: false },
    ]);
  });

  it("ignores visits after the reference instant", async () => {
    const report = await readRetentionReport(
      owner.client,
      { businessId: business.id },
      30,
      "2026-10-31T12:00:00.000Z",
    );
    expect(report.cohorts.at(-1)).toEqual({
      month: "2026-10",
      size: 2,
      returned: 0,
      fullyObserved: false,
    });
  });

  it("refuses a professional of another business and anonymous callers", async () => {
    await expect(
      readRetentionReport(stranger.client, { businessId: business.id }, 30),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      readRetentionReport(anonClient(), { businessId: business.id }, 30),
    ).rejects.toBeTruthy();
  });
});

describe("readRetentionAction", () => {
  it("reads the session's own business only", async () => {
    sessionClient = stranger.client;
    const result = await readRetentionAction({ windowDays: 30 });
    expect(result).toMatchObject({ ok: true, data: { cohorts: [] } });

    sessionClient = owner.client;
    const mine = await readRetentionAction({ windowDays: 90 });
    expect(mine.ok && mine.data.cohorts.map((c) => c.month)).toEqual([
      "2026-07",
      "2026-09",
      "2026-10",
    ]);
  });

  it("refuses a window outside 30, 60 or 90 days and any business id", async () => {
    sessionClient = owner.client;
    expect(await readRetentionAction({ windowDays: 45 })).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
    expect(
      await readRetentionAction({ windowDays: 30, businessId: business.id }),
    ).toMatchObject({ ok: false, error: { code: "validation_error" } });
  });
});
