import { randomUUID } from "node:crypto";

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

// Upgrade from the loyalty engine (20261020090000) to the Client Hub
// (20261021090000) with a populated database: nothing existing is rewritten,
// no customer gains access by the upgrade, and an existing record can be
// authorized afterwards.

const BEFORE = "20261020090000";

let owner: Professional;
let business: TestBusiness;
let client: string;
let before: string;

async function hash() {
  const { rows } = await db.query(
    `select md5(concat_ws('#',
       (select string_agg(c::text, '|' order by c.id) from public.clients c where c.business_id = $1),
       (select string_agg(a::text, '|' order by a.id) from public.appointments a where a.business_id = $1),
       (select string_agg(e::text, '|' order by e.id) from public.loyalty_events e where e.business_id = $1)
     )) as hash`,
    [business.id],
  );
  return rows[0].hash as string;
}

describe("upgrade to the Client Hub", () => {
  beforeAll(async () => {
    resetTo(BEFORE);
    owner = await createProfessional("hub-upgrade");
    business = await createBusiness(owner.userId);
    const service = await createService(business.id);
    client = await createClientRecord(
      business.id,
      `Legacy-${randomUUID().slice(0, 6)}@X.test`,
    );
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: service,
      startsAt: new Date(Date.now() - 50 * 3_600_000).toISOString(),
      endsAt: new Date(Date.now() - 49 * 3_600_000).toISOString(),
      status: "completed",
    });
    await db.query(
      `insert into public.loyalty_events
         (business_id, client_id, type, points_delta, reason, idempotency_key)
       values ($1, $2, 'manual_adjustment', 7, 'x', 'legacy')`,
      [business.id, client],
    );
    before = await hash();
    migrateUp();
  });

  it("rewrites nothing and grants nobody", async () => {
    expect(await hash()).toBe(before);
    const { rows } = await db.query(
      `select (select count(*)::int from public.client_hub_access) as access,
              (select count(*)::int from private.client_hub_accounts) as accounts,
              (select count(*)::int from private.client_hub_sessions) as sessions`,
    );
    expect(rows[0]).toEqual({ access: 0, accounts: 0, sessions: 0 });
  });

  it("an existing record can be authorized, for its canonical email", async () => {
    const { data, error } = await owner.client
      .rpc("client_hub_set_access", {
        p_business_id: business.id,
        p_client_id: client,
        p_granted: true,
      })
      .single();
    expect(error).toBeNull();
    const { rows } = await db.query(
      "select email::text from public.clients where id = $1",
      [client],
    );
    expect(data!.email).toBe(rows[0].email.toLowerCase());
  });
});
