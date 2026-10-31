import { beforeAll, describe, expect, it } from "vitest";

import {
  createBusiness,
  createProfessional,
  createService,
  db,
  type Professional,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade from the Client Hub (20261021090000) to member preferences with a
// populated database: no existing row is touched, nobody gets preferences by
// the upgrade (defaults, version 0), and a member can save hers afterwards.

const BEFORE = "20261021090000";

let owner: Professional;
let business: TestBusiness;
let before: string;

async function hash() {
  const { rows } = await db.query(
    `select md5(concat_ws('#',
       (select string_agg(b::text, '|') from public.businesses b where b.id = $1),
       (select string_agg(m::text, '|' order by m.id) from public.business_members m where m.business_id = $1),
       (select string_agg(s::text, '|' order by s.id) from public.services s where s.business_id = $1)
     )) as hash`,
    [business.id],
  );
  return rows[0].hash as string;
}

describe("upgrade to member preferences", () => {
  beforeAll(async () => {
    resetTo(BEFORE);
    owner = await createProfessional("pref-upgrade");
    business = await createBusiness(owner.userId);
    await createService(business.id);
    before = await hash();
    migrateUp();
  });

  it("rewrites nothing and gives nobody preferences", async () => {
    expect(await hash()).toBe(before);
    const { rows } = await db.query(
      "select count(*)::int as count from public.member_preferences",
    );
    expect(rows[0].count).toBe(0);
  });

  it("an existing member reads the defaults (nothing), then saves hers", async () => {
    const empty = await owner.client.from("member_preferences").select("*");
    expect(empty.data).toEqual([]);
    const { data: read } = await owner.client
      .rpc("read_member_preferences", { p_business_id: business.id })
      .single();
    expect(read).toMatchObject({ incarnation: null, version: 0 });
    const saved = await owner.client
      .rpc("save_member_preferences", {
        p_business_id: business.id,
        p_membership_id: read!.membership_id,
        p_expected_incarnation: null as never,
        p_expected_version: 0,
        p_changes: { style: "studio" },
      })
      .single();
    expect(saved.data).toMatchObject({
      status: "saved",
      style: "studio",
      version: 1,
    });
  });
});
