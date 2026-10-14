import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  listBusinessHoursAction,
  replaceBusinessHoursAction,
} from "@/features/availability/actions/schedule";
import {
  createServiceAction,
  listServicesAction,
  updateServiceAction,
} from "@/features/services/actions/services";
import type { ActionResult } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  createBusiness,
  createProfessional,
  type Professional,
} from "./support/fixtures";

// Ambiguous retries and concurrent edits of services and weekly hours,
// against the real stack (docs/PROFESSIONAL_SETUP.md, "Limites connues").
//
// `it.fails` marks a guarantee the current backend contract does not give:
// the test states the required behaviour and fails today. When the backend
// change lands (docs/SETUP_WRITE_GUARANTEES_HANDOFF.md), these tests start
// passing, Vitest reports them as failing, and they become plain `it`.

let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

let owner: Professional;

beforeAll(async () => {
  owner = await createProfessional("setup-concurrency");
  await createBusiness(owner.userId);
  sessionClient = owner.client;
});

const command = {
  name: "Pose cil à cil",
  description: null,
  durationMinutes: 120,
  priceCents: 11000,
};

describe("service creation", () => {
  it("two services with the same name can be created on purpose", async () => {
    sessionClient = owner.client;
    const before = ok(await listServicesAction()).length;
    ok(await createServiceAction({ ...command, name: "Soin identique" }));
    ok(await createServiceAction({ ...command, name: "Soin identique" }));
    const names = ok(await listServicesAction()).map((service) => service.name);
    expect(names.length).toBe(before + 2);
    expect(names.filter((name) => name === "Soin identique")).toHaveLength(2);
  });

  // Known defect: the creation contract carries no request id, so a retry
  // after a lost answer (the first creation committed) is indistinguishable
  // from a second creation and writes a duplicate.
  it.fails(
    "a retry of the same creation request never writes a second service",
    async () => {
      sessionClient = owner.client;
      const requestId = randomUUID();
      const name = `Retry ${requestId.slice(0, 8)}`;
      // First attempt: committed, but its answer is lost on the way back.
      ok(await createServiceAction({ ...command, name, requestId }));
      // The professional retries the same request.
      ok(await createServiceAction({ ...command, name, requestId }));
      const created = ok(await listServicesAction()).filter(
        (service) => service.name === name,
      );
      expect(created).toHaveLength(1);
    },
  );
});

describe("concurrent edits of a service", () => {
  it("edits of different fields from two sessions both survive (only changed fields are sent)", async () => {
    sessionClient = owner.client;
    const service = ok(
      await createServiceAction({ ...command, name: "Champs distincts" }),
    );
    // Session A changes the price, session B the duration.
    ok(
      await updateServiceAction({
        serviceId: service.id,
        changes: { priceCents: 12000 },
      }),
    );
    ok(
      await updateServiceAction({
        serviceId: service.id,
        changes: { durationMinutes: 90 },
      }),
    );
    const current = ok(await listServicesAction()).find(
      (item) => item.id === service.id,
    );
    expect(current).toMatchObject({ priceCents: 12000, durationMinutes: 90 });
  });

  // Known defect: no version on services, so an edit of the same field
  // based on an outdated read silently overwrites the other session's.
  it.fails(
    "an edit of the same field based on an outdated read is refused, not silently applied",
    async () => {
      sessionClient = owner.client;
      const service = ok(
        await createServiceAction({ ...command, name: "Même champ" }),
      );
      const readByA = ok(await listServicesAction()).find(
        (item) => item.id === service.id,
      )!;
      // Session B saves a new price first.
      ok(
        await updateServiceAction({
          serviceId: service.id,
          changes: { priceCents: 13000 },
        }),
      );
      // Session A saves its own price, based on what it read before.
      const result = await updateServiceAction({
        serviceId: service.id,
        expectedVersion: readByA,
        changes: { priceCents: 12500 },
      });
      expect(result.ok).toBe(false);
      const current = ok(await listServicesAction()).find(
        (item) => item.id === service.id,
      );
      expect(current?.priceCents).toBe(13000);
    },
  );
});

describe("concurrent edits of the weekly hours", () => {
  // Known defect: no version on the schedule. The screen reads it again
  // before saving (a stale form is detected), but two writes racing after
  // that check: the last one replaces the other's week.
  it.fails(
    "a week saved on the basis of an outdated read is refused, not silently applied",
    async () => {
      sessionClient = owner.client;
      ok(
        await replaceBusinessHoursAction({
          hours: [{ weekday: 1, startsAt: "09:00", endsAt: "18:00" }],
        }),
      );
      const readByA = ok(await listBusinessHoursAction());
      // Session B saves another week first.
      ok(
        await replaceBusinessHoursAction({
          hours: [{ weekday: 2, startsAt: "10:00", endsAt: "16:00" }],
        }),
      );
      // Session A saves its week, based on what it read before.
      const result = await replaceBusinessHoursAction({
        expected: readByA,
        hours: [{ weekday: 1, startsAt: "09:00", endsAt: "17:00" }],
      });
      expect(result.ok).toBe(false);
      expect(
        ok(await listBusinessHoursAction()).map((range) => range.weekday),
      ).toEqual([2]);
    },
  );
});
