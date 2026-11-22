import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade to the appointment history (point 100) with appointments already
// there: none of them is rewritten; each gets its creation (with its details
// when it never changed, by the client when created online), and one entry
// says that earlier changes were not recorded. Changes after the upgrade are
// recorded as usual.

const BEFORE = "20261122180000";

type Entry = {
  version: number;
  actor: { kind: string; isYou: boolean };
  backfilled: boolean;
  changes: ({ type: string } & Record<string, unknown>)[];
};

let owner: Professional;
let business: TestBusiness;
let online: string;
let manual: string;
let before: string;

const future = (days: number, hour: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

async function hash() {
  const { rows } = await db.query(
    `select md5(string_agg(to_jsonb(a)::text, '|' order by a.id)) as hash
     from public.appointments a where a.business_id = $1`,
    [business.id],
  );
  return rows[0].hash as string;
}

async function history(id: string) {
  const { data, error } = await owner.client.rpc(
    "appointment_history" as never,
    { p_business_id: business.id, p_appointment_id: id } as never,
  );
  expect(error).toBeNull();
  return (data as unknown as { entries: Entry[] }).entries;
}

describe("upgrade to the appointment history", () => {
  beforeAll(async () => {
    resetTo(BEFORE);
    owner = await createProfessional("history-upgrade");
    business = await createBusiness(owner.userId);
    const service = await createService(business.id, { name: "Coupe" });
    const client = await createClientRecord(business.id, "zoe@client.test");
    // Booked online (no author), never changed.
    online = await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: future(10, 9),
      endsAt: future(10, 10),
    });
    // Added by her, then moved twice.
    manual = await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: future(11, 9),
      endsAt: future(11, 10),
    });
    await db.query(
      "update public.appointments set created_by = $2 where id = $1",
      [manual, owner.userId],
    );
    for (const hour of [12, 14]) {
      await db.query(
        "update public.appointments set starts_at = $2, ends_at = $3 where id = $1",
        [manual, future(11, hour), future(11, hour + 1)],
      );
    }
    before = await hash();
    migrateUp();
    // The API learns the new function once its schema cache is reloaded.
    await db.query("notify pgrst, 'reload schema'");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { error } = await owner.client.rpc(
        "appointment_history" as never,
        { p_business_id: business.id, p_appointment_id: online } as never,
      );
      if (error?.code !== "PGRST202") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  it("rewrites no appointment", async () => {
    expect(await hash()).toBe(before);
  });

  it("an unchanged appointment: its creation with its details, by the client", async () => {
    const entries = await history(online);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      version: 1,
      backfilled: true,
      actor: { kind: "client", isYou: false },
    });
    expect(entries[0]!.changes).toEqual([
      expect.objectContaining({ type: "created", serviceName: "Coupe" }),
    ]);
  });

  it("a changed one: its creation by her, then earlier changes not recorded", async () => {
    const { rows } = await db.query<{ version: number }>(
      "select version from public.appointments where id = $1",
      [manual],
    );
    const entries = await history(manual);
    expect(entries.map((e) => [e.version, e.changes])).toEqual([
      [rows[0]!.version, [{ type: "untracked" }]],
      [1, [{ type: "created" }]],
    ]);
    expect(entries[1]!.actor).toMatchObject({ kind: "member", isYou: true });
  });

  it("a change after the upgrade is recorded as usual", async () => {
    await db.query(
      "update public.appointments set internal_notes = 'Après' where id = $1",
      [online],
    );
    const [latest] = await history(online);
    expect(latest).toMatchObject({
      backfilled: false,
      actor: { kind: "system" },
      changes: [{ type: "notes" }],
    });
  });
});
