import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { getAgendaAction } from "@/features/agenda/actions/agenda";
import {
  listBusinessHoursAction,
  replaceBusinessHoursAction,
} from "@/features/availability/actions/schedule";
import {
  createServiceAction,
  deleteServiceAction,
  listServicesAction,
  reorderServicesAction,
  setServiceActiveAction,
  updateServiceAction,
} from "@/features/services/actions/services";
import type { ServiceDto } from "@/features/services/data/services";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
  type OpenTransaction,
} from "./support/transactions";

// Ambiguous retries and concurrent edits of services and weekly hours,
// against the real stack: the Server Actions, the user's session, row level
// security and PostgreSQL (docs/SETUP_WRITE_GUARANTEES_HANDOFF.md).
// Interleavings that must be deterministic use transactions on their own
// connections (support/transactions).

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

function failure<T>(result: ActionResult<T>, code: AppErrorCode) {
  expect(result).toMatchObject({ ok: false, error: { code } });
}

let owner: Professional;
let intruder: Professional;
let business: TestBusiness;
let foreign: TestBusiness;

beforeAll(async () => {
  [owner, intruder] = await Promise.all([
    createProfessional("setup-concurrency"),
    createProfessional("setup-concurrency-intruder"),
  ]);
  business = await createBusiness(owner.userId);
  foreign = await createBusiness(intruder.userId);
  sessionClient = owner.client;
});

const command = {
  name: "Pose cil à cil",
  description: null,
  durationMinutes: 120,
  priceCents: 11000,
};

function as(professional: Professional) {
  sessionClient = professional.client;
}

async function servicesNamed(businessId: string, name: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.services where business_id = $1 and name = $2",
    [businessId, name],
  );
  return rows.map((row) => row.id);
}

async function serviceRow(id: string) {
  const { rows } = await db.query(
    `select name, description, duration_minutes, price_cents, active,
            display_order, version
     from public.services where id = $1`,
    [id],
  );
  return rows[0];
}

/** A transaction of the owner's session (authenticated, RLS on). */
function ownerTransaction() {
  return openTransaction({ role: "authenticated", userId: owner.userId });
}

function createIn(
  transaction: OpenTransaction,
  requestId: string,
  name: string,
  priceCents = 11000,
) {
  return transaction.connection.query<{ status: string; service_id: string }>(
    `select * from public.create_service(
       p_business_id => $1, p_request_id => $2, p_name => $3,
       p_duration_minutes => 120, p_price_cents => $4)`,
    [business.id, requestId, name, priceCents],
  );
}

const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// 1. Service creation: idempotent by request
// ---------------------------------------------------------------------------

describe("service creation", () => {
  it("two services with the same name can be created on purpose (two requests)", async () => {
    as(owner);
    const name = unique("Soin identique");
    const first = ok(
      await createServiceAction({ ...command, name, requestId: randomUUID() }),
    );
    const second = ok(
      await createServiceAction({ ...command, name, requestId: randomUUID() }),
    );
    expect(second.id).not.toBe(first.id);
    expect(await servicesNamed(business.id, name)).toHaveLength(2);
  });

  it("a retry of the same creation request never writes a second service", async () => {
    as(owner);
    const requestId = randomUUID();
    const name = unique("Retry");
    // First attempt: committed, but its answer is lost on the way back.
    const first = ok(
      await createServiceAction({ ...command, name, requestId }),
    );
    // The professional retries the same request.
    const retried = ok(
      await createServiceAction({ ...command, name, requestId }),
    );
    expect(retried).toEqual(first);
    expect(await servicesNamed(business.id, name)).toEqual([first.id]);
  });

  it("a retry answers the service as it is now, after an edit", async () => {
    as(owner);
    const requestId = randomUUID();
    const name = unique("Retry after edit");
    const created = ok(
      await createServiceAction({ ...command, name, requestId }),
    );
    const edited = ok(
      await updateServiceAction({
        serviceId: created.id,
        expectedVersion: created.version,
        changes: { priceCents: 12000 },
      }),
    );
    const retried = ok(
      await createServiceAction({ ...command, name, requestId }),
    );
    expect(retried).toEqual(edited);
    expect(await servicesNamed(business.id, name)).toEqual([created.id]);
  });

  it("concurrent identical retries create one service", async () => {
    as(owner);
    const requestId = randomUUID();
    const name = unique("Concurrent retry");
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createServiceAction({ ...command, name, requestId }),
      ),
    );
    const ids = new Set(results.map((result) => ok(result).id));
    expect(ids.size).toBe(1);
    expect(await servicesNamed(business.id, name)).toEqual([...ids]);
  });

  it("a retry waits for the first attempt in progress, then is answered with its service", async () => {
    const requestId = randomUUID();
    const name = unique("Waiting retry");
    const first = await ownerTransaction();
    const second = await ownerTransaction();
    try {
      const created = (await createIn(first, requestId, name)).rows[0]!;
      expect(created.status).toBe("created");

      const replay = createIn(second, requestId, name);
      await waitUntilBlocked(second.pid);
      await closeTransaction(first, "commit");

      expect((await replay).rows[0]).toEqual({
        status: "replayed",
        service_id: created.service_id,
      });
    } finally {
      await closeTransaction(second, "commit").catch(() => undefined);
      await closeTransaction(first, "rollback").catch(() => undefined);
    }
    expect(await servicesNamed(business.id, name)).toHaveLength(1);
  });

  it("a retry of an attempt that rolled back creates the service, once", async () => {
    const requestId = randomUUID();
    const name = unique("Rolled back");
    const first = await ownerTransaction();
    const second = await ownerTransaction();
    try {
      await createIn(first, requestId, name);
      const retry = createIn(second, requestId, name);
      await waitUntilBlocked(second.pid);
      await closeTransaction(first, "rollback");
      expect((await retry).rows[0]!.status).toBe("created");
    } finally {
      await closeTransaction(second, "commit").catch(() => undefined);
    }
    expect(await servicesNamed(business.id, name)).toHaveLength(1);
  });

  it("the same request with another command is refused, and writes nothing", async () => {
    as(owner);
    const requestId = randomUUID();
    const name = unique("Bound");
    const created = ok(
      await createServiceAction({ ...command, name, requestId }),
    );
    for (const changed of [
      { name: `${name} (bis)` },
      { priceCents: 9900 },
      { durationMinutes: 90 },
      { description: "Autre" },
      { active: false },
      { displayOrder: 3 },
    ]) {
      failure(
        await createServiceAction({ ...command, name, requestId, ...changed }),
        "idempotency_conflict",
      );
    }
    expect(await servicesNamed(business.id, name)).toEqual([created.id]);
    expect(await serviceRow(created.id)).toMatchObject({
      price_cents: 11000,
      version: 1,
    });
  });

  it("a request whose service was deleted since is never created again", async () => {
    as(owner);
    const requestId = randomUUID();
    const name = unique("Deleted");
    const created = ok(
      await createServiceAction({ ...command, name, requestId }),
    );
    ok(await deleteServiceAction({ serviceId: created.id }));

    failure(
      await createServiceAction({ ...command, name, requestId }),
      "service_deleted",
    );
    // Another command under that request is still a conflict.
    failure(
      await createServiceAction({ ...command, name, requestId, priceCents: 1 }),
      "idempotency_conflict",
    );
    expect(await servicesNamed(business.id, name)).toEqual([]);
  });

  it("a creation that fails records nothing: the same request can be sent again, corrected", async () => {
    const requestId = randomUUID();
    const name = unique("Corrected");
    const refused = await owner.client.rpc("create_service", {
      p_business_id: business.id,
      p_request_id: requestId,
      p_name: name,
      p_duration_minutes: 120,
      p_price_cents: -1,
    });
    expect(refused.error?.code).toBe("23514");

    as(owner);
    const created = ok(
      await createServiceAction({ ...command, name, requestId }),
    );
    expect(await servicesNamed(business.id, name)).toEqual([created.id]);
  });

  it("a request id is scoped to the business: another tenant's identical id neither reveals nor affects it", async () => {
    as(owner);
    const requestId = randomUUID();
    const name = unique("Tenant");
    const mine = ok(await createServiceAction({ ...command, name, requestId }));

    // The intruder sends the same request id with another command: it is
    // a new request of their own business, not a conflict with mine.
    as(intruder);
    const theirs = ok(
      await createServiceAction({
        ...command,
        name: "Autre",
        priceCents: 1,
        requestId,
      }),
    );
    expect(theirs.id).not.toBe(mine.id);
    // ... and the same command again is their own replay.
    expect(
      ok(
        await createServiceAction({
          ...command,
          name: "Autre",
          priceCents: 1,
          requestId,
        }),
      ),
    ).toEqual(theirs);

    // A forged business id is refused before anything is read or written.
    const forged = await intruder.client.rpc("create_service", {
      p_business_id: business.id,
      p_request_id: requestId,
      p_name: name,
      p_duration_minutes: 120,
      p_price_cents: 11000,
    });
    expect(forged.error?.message).toBe("forbidden");
    const anonymous = await anonClient().rpc("create_service", {
      p_business_id: business.id,
      p_request_id: randomUUID(),
      p_name: name,
      p_duration_minutes: 120,
      p_price_cents: 11000,
    });
    expect(anonymous.error).not.toBeNull();

    expect(await servicesNamed(business.id, name)).toEqual([mine.id]);
    expect(await servicesNamed(foreign.id, "Autre")).toEqual([theirs.id]);
  });

  it("the request records are unreachable from the API", async () => {
    const t = await openTransaction({
      role: "authenticated",
      userId: owner.userId,
    });
    const read = await outcome(
      t.connection.query("select * from private.service_creation_requests"),
    );
    await closeTransaction(t, "rollback");
    expect(read).toMatch(/permission denied/);

    const { rows } = await db.query(
      `select
         has_function_privilege('anon', 'public.create_service(uuid, uuid, text, integer, integer, text, boolean, integer)', 'execute') as anon,
         has_function_privilege('authenticated', 'public.create_service(uuid, uuid, text, integer, integer, text, boolean, integer)', 'execute') as authenticated`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: true });
  });

  it("puts a new service last, as before", async () => {
    as(owner);
    const before = ok(await listServicesAction());
    const last = Math.max(-1, ...before.map((item) => item.displayOrder));
    const created = ok(
      await createServiceAction({
        ...command,
        name: unique("Last"),
        requestId: randomUUID(),
      }),
    );
    expect(created).toMatchObject({ displayOrder: last + 1, version: 1 });
  });
});

// ---------------------------------------------------------------------------
// 2. Service edits: optimistic concurrency
// ---------------------------------------------------------------------------

async function newService(label: string): Promise<ServiceDto> {
  as(owner);
  return ok(
    await createServiceAction({
      ...command,
      name: unique(label),
      requestId: randomUUID(),
    }),
  );
}

describe("concurrent edits of a service", () => {
  it("an edit of the same field based on an outdated read is refused, not silently applied", async () => {
    const service = await newService("Même champ");
    const readByA = ok(await listServicesAction()).find(
      (item) => item.id === service.id,
    )!;
    // Session B saves a new price first.
    ok(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: readByA.version,
        changes: { priceCents: 13000 },
      }),
    );
    // Session A saves its own price, based on what it read before.
    const result = await updateServiceAction({
      serviceId: service.id,
      expectedVersion: readByA.version,
      changes: { priceCents: 12500 },
    });
    failure(result, "stale_service");
    const current = ok(await listServicesAction()).find(
      (item) => item.id === service.id,
    );
    expect(current).toMatchObject({ priceCents: 13000, version: 2 });
  });

  it("two simultaneous edits of one version: exactly one applies, the other is refused", async () => {
    const service = await newService("Simultanées");
    const results = await Promise.all(
      [12000, 12500].map((priceCents) =>
        updateServiceAction({
          serviceId: service.id,
          expectedVersion: service.version,
          changes: { priceCents },
        }),
      ),
    );
    const applied = results.filter((result) => result.ok);
    expect(applied).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "stale_service" }),
      }),
    ]);
    const winner = ok(applied[0]!);
    expect(await serviceRow(service.id)).toMatchObject({
      price_cents: winner.priceCents,
      version: 2,
    });
  });

  it("a waiting edit sees the committed one and is refused (the compare and swap is the UPDATE)", async () => {
    const service = await newService("Attente");
    const first = await ownerTransaction();
    const second = await ownerTransaction();
    const edit = (t: OpenTransaction, price: number) =>
      t.connection.query(
        "update public.services set price_cents = $1 where id = $2 and version = $3 returning version",
        [price, service.id, service.version],
      );
    try {
      expect((await edit(first, 12000)).rows).toEqual([{ version: 2 }]);
      const late = edit(second, 12500);
      await waitUntilBlocked(second.pid);
      await closeTransaction(first, "commit");
      expect((await late).rows).toEqual([]);
    } finally {
      await closeTransaction(second, "commit").catch(() => undefined);
      await closeTransaction(first, "rollback").catch(() => undefined);
    }
    expect(await serviceRow(service.id)).toMatchObject({
      price_cents: 12000,
      version: 2,
    });
  });

  it("only the changed fields are written; edits each based on the latest version all survive", async () => {
    const service = await newService("Champs distincts");
    const priced = ok(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version,
        changes: { priceCents: 12000 },
      }),
    );
    const timed = ok(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: priced.version,
        changes: { durationMinutes: 90 },
      }),
    );
    expect(timed).toMatchObject({
      name: service.name,
      description: null,
      priceCents: 12000,
      durationMinutes: 90,
      active: true,
      displayOrder: service.displayOrder,
      version: 3,
    });
  });

  it("an edit of another field based on an outdated read is refused too: the version is the service's", async () => {
    const service = await newService("Autre champ");
    ok(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version,
        changes: { priceCents: 12000 },
      }),
    );
    failure(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version,
        changes: { durationMinutes: 90 },
      }),
      "stale_service",
    );
    expect(await serviceRow(service.id)).toMatchObject({
      price_cents: 12000,
      duration_minutes: 120,
      version: 2,
    });
  });

  it("a retried edit (its answer lost) answers the service, whatever the version, without writing again", async () => {
    const service = await newService("Edit retry");
    const edit = {
      serviceId: service.id,
      expectedVersion: service.version,
      changes: { priceCents: 12000, description: "Nouveau" },
    };
    const first = ok(await updateServiceAction(edit));
    expect(first.version).toBe(2);
    expect(ok(await updateServiceAction(edit))).toEqual(first);
    expect(await serviceRow(service.id)).toMatchObject({ version: 2 });
  });

  it("an edit that changes nothing keeps the version", async () => {
    const service = await newService("Unchanged");
    const same = ok(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version,
        changes: { priceCents: service.priceCents },
      }),
    );
    expect(same).toEqual(service);
  });

  it("reordering never makes an open form stale, and keeps its order", async () => {
    const service = await newService("Ordre");
    const all = ok(await listServicesAction());
    const reversed = all.map((item) => item.id).reverse();
    const reordered = ok(await reorderServicesAction({ serviceIds: reversed }));
    const moved = reordered.find((item) => item.id === service.id)!;
    expect(moved.version).toBe(service.version);

    const edited = ok(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version,
        changes: { priceCents: 9000 },
      }),
    );
    expect(edited).toMatchObject({
      priceCents: 9000,
      displayOrder: moved.displayOrder,
      version: service.version + 1,
    });
    expect(ok(await listServicesAction()).map((item) => item.id)).toEqual(
      reversed,
    );
  });

  it("activation: by value without a version, refused with an outdated one", async () => {
    const service = await newService("Active");
    const inactive = ok(
      await setServiceActiveAction({ serviceId: service.id, active: false }),
    );
    expect(inactive).toMatchObject({ active: false, version: 2 });
    // Deactivating again is the same state: nothing changes.
    expect(
      ok(
        await setServiceActiveAction({
          serviceId: service.id,
          active: false,
          expectedVersion: service.version,
        }),
      ),
    ).toEqual(inactive);
    // Reactivating on the basis of the outdated read is refused.
    failure(
      await setServiceActiveAction({
        serviceId: service.id,
        active: true,
        expectedVersion: service.version,
      }),
      "stale_service",
    );
    expect(await serviceRow(service.id)).toMatchObject({
      active: false,
      version: 2,
    });
    // ... and accepted on the current one; an edit keeps the state.
    const active = ok(
      await setServiceActiveAction({
        serviceId: service.id,
        active: true,
        expectedVersion: inactive.version,
      }),
    );
    expect(active).toMatchObject({ active: true, version: 3 });
  });

  it("the version belongs to the database: a value written by a member is ignored", async () => {
    const service = await newService("Version");
    const forged = await owner.client
      .from("services")
      .update({ version: 99, price_cents: 12000 })
      .eq("id", service.id)
      .select("version")
      .single();
    expect(forged.data).toEqual({ version: 2 });
    const reset = await owner.client
      .from("services")
      .update({ version: 1 })
      .eq("id", service.id)
      .select("version")
      .single();
    expect(reset.data).toEqual({ version: 2 });
    const inserted = await owner.client
      .from("services")
      .insert({
        business_id: business.id,
        name: unique("Inserted"),
        duration_minutes: 30,
        price_cents: 0,
        version: 50,
      })
      .select("version")
      .single();
    expect(inserted.data).toEqual({ version: 1 });
  });

  it("an edit keeps the snapshots of appointments booked before it", async () => {
    const service = await newService("Snapshot");
    const client = await createClientRecord(
      business.id,
      `${randomUUID()}@x.test`,
    );
    const starts = new Date(Date.now() + 40 * 86_400_000);
    starts.setUTCHours(9, 0, 0, 0);
    const appointment = await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service.id,
      startsAt: starts.toISOString(),
      endsAt: new Date(starts.getTime() + 120 * 60_000).toISOString(),
    });
    ok(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version,
        changes: {
          name: unique("Renamed"),
          priceCents: 15000,
          durationMinutes: 60,
        },
      }),
    );
    const { rows } = await db.query(
      `select service_name_snapshot, price_cents_snapshot, duration_minutes_snapshot
       from public.appointments where id = $1`,
      [appointment],
    );
    expect(rows[0]).toEqual({
      service_name_snapshot: service.name,
      price_cents_snapshot: 11000,
      duration_minutes_snapshot: 120,
    });
  });

  it("another business can neither edit nor learn anything about a service", async () => {
    const service = await newService("Privée");
    as(intruder);
    failure(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version,
        changes: { priceCents: 1 },
      }),
      "not_found",
    );
    // A wrong version gives the same answer: nothing tells it exists.
    failure(
      await updateServiceAction({
        serviceId: service.id,
        expectedVersion: service.version + 5,
        changes: { priceCents: 1 },
      }),
      "not_found",
    );
    failure(
      await setServiceActiveAction({ serviceId: service.id, active: false }),
      "not_found",
    );
    expect(await serviceRow(service.id)).toMatchObject({
      price_cents: 11000,
      active: true,
      version: 1,
    });
  });

  it("an edit without a version is refused (validation), nothing written", async () => {
    const service = await newService("Sans version");
    failure(
      await updateServiceAction({
        serviceId: service.id,
        changes: { priceCents: 1 },
      }),
      "validation_error",
    );
    expect(await serviceRow(service.id)).toMatchObject({ price_cents: 11000 });
  });
});

// ---------------------------------------------------------------------------
// 3. Weekly hours: replaced only from the week they were read as
// ---------------------------------------------------------------------------

const weekOf = (
  hours: { weekday: number; startsAt: string; endsAt: string }[],
) =>
  hours.map(({ weekday, startsAt, endsAt }) => ({ weekday, startsAt, endsAt }));

async function hoursOf(businessId: string) {
  const { rows } = await db.query<{ id: string; range: string }>(
    `select id, weekday || ' ' || to_char(starts_at, 'HH24:MI') || '-' || to_char(ends_at, 'HH24:MI') as range
     from public.business_hours where business_id = $1 order by weekday, starts_at`,
    [businessId],
  );
  return rows;
}

describe("concurrent edits of the weekly hours", () => {
  it("a week saved on the basis of an outdated read is refused, not silently applied", async () => {
    as(owner);
    ok(
      await replaceBusinessHoursAction({
        hours: [{ weekday: 1, startsAt: "09:00", endsAt: "18:00" }],
        expected: ok(await listBusinessHoursAction()),
      }),
    );
    const readByA = ok(await listBusinessHoursAction());
    // Session B saves another week first.
    ok(
      await replaceBusinessHoursAction({
        hours: [{ weekday: 2, startsAt: "10:00", endsAt: "16:00" }],
        expected: readByA,
      }),
    );
    // Session A saves its week, based on what it read before.
    const result = await replaceBusinessHoursAction({
      expected: readByA,
      hours: [{ weekday: 1, startsAt: "09:00", endsAt: "17:00" }],
    });
    failure(result, "stale_business_hours");
    expect(
      ok(await listBusinessHoursAction()).map((range) => range.weekday),
    ).toEqual([2]);
  });

  it("two simultaneous saves of the same week: exactly one applies, never a merge", async () => {
    as(owner);
    const read = ok(await listBusinessHoursAction());
    const weeks = [
      [{ weekday: 3, startsAt: "09:00", endsAt: "12:00" }],
      [
        { weekday: 4, startsAt: "14:00", endsAt: "18:00" },
        { weekday: 5, startsAt: "14:00", endsAt: "18:00" },
      ],
    ];
    const results = await Promise.all(
      weeks.map((hours) =>
        replaceBusinessHoursAction({ hours, expected: read }),
      ),
    );
    const applied = results.flatMap((result, index) =>
      result.ok ? [index] : [],
    );
    expect(applied).toHaveLength(1);
    for (const result of results) {
      if (!result.ok) failure(result, "stale_business_hours");
    }
    expect(weekOf(ok(await listBusinessHoursAction()))).toEqual(
      weeks[applied[0]!],
    );
  });

  it("a waiting save sees the week committed meanwhile and is refused (under the schedule lock)", async () => {
    as(owner);
    const read = ok(await listBusinessHoursAction());
    const rows = (hours: [number, string, string][]) =>
      JSON.stringify(
        hours.map(([weekday, starts_at, ends_at]) => ({
          weekday,
          starts_at,
          ends_at,
        })),
      );
    const expected = rows(
      read.map((range) => [range.weekday, range.startsAt, range.endsAt]),
    );
    const replace = (t: OpenTransaction, hours: [number, string, string][]) =>
      t.connection.query(
        "select * from public.replace_business_hours($1, $2, $3)",
        [business.id, rows(hours), expected],
      );
    const first = await ownerTransaction();
    const second = await ownerTransaction();
    try {
      await replace(first, [[1, "08:00", "12:00"]]);
      const late = outcome(replace(second, [[2, "08:00", "12:00"]]));
      await waitUntilBlocked(second.pid);
      await closeTransaction(first, "commit");
      expect(await late).toBe("stale_business_hours");
    } finally {
      await closeTransaction(second, "rollback").catch(() => undefined);
      await closeTransaction(first, "rollback").catch(() => undefined);
    }
    expect((await hoursOf(business.id)).map((row) => row.range)).toEqual([
      "1 08:00-12:00",
    ]);
  });

  it("a retried save (its answer lost) answers the week, whatever the basis, without rewriting it", async () => {
    as(owner);
    const read = ok(await listBusinessHoursAction());
    const save = {
      hours: [
        { weekday: 1, startsAt: "09:00", endsAt: "12:00" },
        { weekday: 1, startsAt: "14:00", endsAt: "18:00" },
      ],
      expected: read,
    };
    const saved = ok(await replaceBusinessHoursAction(save));
    const ids = (await hoursOf(business.id)).map((row) => row.id);
    expect(ok(await replaceBusinessHoursAction(save))).toEqual(saved);
    expect((await hoursOf(business.id)).map((row) => row.id)).toEqual(ids);
  });

  it("the basis compares ranges, not their order or ids", async () => {
    as(owner);
    ok(
      await replaceBusinessHoursAction({
        hours: [
          { weekday: 1, startsAt: "09:00", endsAt: "12:00" },
          { weekday: 5, startsAt: "09:00", endsAt: "12:00" },
        ],
        expected: ok(await listBusinessHoursAction()),
      }),
    );
    const read = weekOf(ok(await listBusinessHoursAction())).reverse();
    expect(
      weekOf(
        ok(
          await replaceBusinessHoursAction({
            hours: [{ weekday: 6, startsAt: "10:00", endsAt: "13:00" }],
            expected: read,
          }),
        ),
      ),
    ).toEqual([{ weekday: 6, startsAt: "10:00", endsAt: "13:00" }]);
    // A basis missing one range, or with one more, is outdated.
    for (const expected of [
      [],
      [
        { weekday: 6, startsAt: "10:00", endsAt: "13:00" },
        { weekday: 6, startsAt: "10:00", endsAt: "13:00" },
      ],
      [{ weekday: 6, startsAt: "10:00", endsAt: "13:30" }],
    ]) {
      failure(
        await replaceBusinessHoursAction({
          hours: [{ weekday: 0, startsAt: "10:00", endsAt: "13:00" }],
          expected,
        }),
        "stale_business_hours",
      );
    }
  });

  it("an invalid week is refused as a whole, on any basis, keeping the saved one", async () => {
    as(owner);
    const before = await hoursOf(business.id);
    const read = ok(await listBusinessHoursAction());
    const overlapping = [
      { weekday: 1, startsAt: "09:00", endsAt: "13:00" },
      { weekday: 1, startsAt: "12:00", endsAt: "18:00" },
    ];
    failure(
      await replaceBusinessHoursAction({ hours: overlapping, expected: read }),
      "validation_error",
    );
    // Straight to the database: the constraint refuses it, nothing changes.
    const direct = await owner.client.rpc("replace_business_hours", {
      p_business_id: business.id,
      p_hours: overlapping.map((range) => ({
        weekday: range.weekday,
        starts_at: range.startsAt,
        ends_at: range.endsAt,
      })),
      p_expected: read.map((range) => ({
        weekday: range.weekday,
        starts_at: range.startsAt,
        ends_at: range.endsAt,
      })),
    });
    expect(direct.error).not.toBeNull();
    expect(await hoursOf(business.id)).toEqual(before);
  });

  it("no API path replaces the week without its basis", async () => {
    as(owner);
    const before = await hoursOf(business.id);
    failure(
      await replaceBusinessHoursAction({
        hours: [{ weekday: 0, startsAt: "10:00", endsAt: "11:00" }],
      }),
      "validation_error",
    );
    const legacy = await owner.client.rpc(
      "replace_business_hours" as never,
      { p_business_id: business.id, p_hours: [] } as never,
    );
    expect(legacy.error).not.toBeNull();
    const nullBasis = await owner.client.rpc("replace_business_hours", {
      p_business_id: business.id,
      p_hours: [],
      p_expected: null,
    });
    expect(nullBasis.error?.message).toBe("invalid_hours");
    expect(await hoursOf(business.id)).toEqual(before);
  });

  it("another business's week is never read nor replaced", async () => {
    as(owner);
    const before = await hoursOf(business.id);
    const forged = await intruder.client.rpc("replace_business_hours", {
      p_business_id: business.id,
      p_hours: [],
      p_expected: [],
    });
    expect(forged.error?.message).toBe("forbidden");
    const anonymous = await anonClient().rpc("replace_business_hours", {
      p_business_id: business.id,
      p_hours: [],
      p_expected: [],
    });
    expect(anonymous.error).not.toBeNull();
    // The intruder's session replaces its own (empty) week only.
    as(intruder);
    ok(
      await replaceBusinessHoursAction({
        hours: [{ weekday: 2, startsAt: "10:00", endsAt: "11:00" }],
        expected: [],
      }),
    );
    expect(await hoursOf(business.id)).toEqual(before);
    const { rows } = await db.query(
      `select
         has_function_privilege('anon', 'public.replace_business_hours(uuid, jsonb, jsonb)', 'execute') as anon,
         has_function_privilege('authenticated', 'public.replace_business_hours(uuid, jsonb, jsonb)', 'execute') as authenticated`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: true });
  });

  it("saved hours keep their wall-clock meaning across a DST change (business time zone)", async () => {
    as(owner);
    // Saturday and Sunday 09:00–12:00 in Europe/Paris: summer time ends on
    // Sunday 25 October 2026.
    ok(
      await replaceBusinessHoursAction({
        hours: [
          { weekday: 6, startsAt: "09:00", endsAt: "12:00" },
          { weekday: 0, startsAt: "09:00", endsAt: "12:00" },
        ],
        expected: ok(await listBusinessHoursAction()),
      }),
    );
    const agenda = ok(
      await getAgendaAction({ startDate: "2026-10-24", endDate: "2026-10-25" }),
    );
    expect(
      agenda.workingHours.days.map((day) =>
        day.openRanges.map((range) => [range.localStartsAt, range.startsAt]),
      ),
    ).toEqual([
      [["2026-10-24T09:00", "2026-10-24T07:00:00.000Z"]],
      [["2026-10-25T09:00", "2026-10-25T08:00:00.000Z"]],
    ]);
  });
});
