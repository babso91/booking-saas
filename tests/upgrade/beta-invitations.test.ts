import { beforeAll, describe, expect, it } from "vitest";

import { completeOnboarding } from "@/features/onboarding/data/onboarding";
import { completeOnboardingSchema } from "@/features/onboarding/schemas/onboarding";

import {
  createBusiness,
  createProfessional,
  db,
  uniqueSlug,
  type Professional,
  type TestBusiness,
} from "../integration/support/fixtures";
import { migrateUp, resetTo } from "./support";

// Upgrade from the catalogue (20261103090000) to the private beta with a
// populated database: a professional with her business, another account
// that never finished onboarding. Both keep what they could do; their rows
// are untouched; a new account made after the upgrade needs an invitation.

const BEFORE = "20261103090000";

let established: Professional;
let business: TestBusiness;
let unfinished: Professional;
let beforeRows: string;

async function rows() {
  const { rows } = await db.query(
    `select md5(concat_ws('#',
       (select string_agg(concat_ws(',', b.id, b.name, b.slug, b.created_by), '|' order by b.id)
        from public.businesses b where b.id = $1),
       (select string_agg(concat_ws(',', m.id, m.user_id, m.role), '|' order by m.id)
        from public.business_members m where m.business_id = $1),
       (select string_agg(concat_ws(',', u.id, u.email, u.encrypted_password), '|' order by u.id)
        from auth.users u where u.id = any($2))
     )) as hash`,
    [business.id, [established.userId, unfinished.userId]],
  );
  return rows[0].hash as string;
}

const input = () =>
  completeOnboardingSchema.parse({
    firstName: "Inès",
    lastName: "Roy",
    businessName: "Studio Inès",
    slug: uniqueSlug("ines"),
  });

beforeAll(async () => {
  resetTo(BEFORE);
  // Before the beta's tables exist: createProfessional grants nothing.
  established = await createProfessional("upgrade-established");
  business = await createBusiness(established.userId);
  unfinished = await createProfessional("upgrade-unfinished");
  beforeRows = await rows();
  migrateUp();
});

describe("upgrade: catalogue → private beta", () => {
  it("existing accounts keep their access; nothing is rewritten", async () => {
    expect(await rows()).toBe(beforeRows);
    const { rows: access } = await db.query(
      "select user_id, source from private.beta_access where user_id = any($1) order by source, user_id",
      [[established.userId, unfinished.userId]],
    );
    expect(access).toHaveLength(2);
    expect(access.every((row) => row.source === "existing")).toBe(true);
  });

  it("an account made before can still finish its onboarding", async () => {
    const created = await completeOnboarding(unfinished.client, input());
    expect(created.businessName).toBe("Studio Inès");
  });

  it("an account made after the upgrade, without invitation, cannot", async () => {
    const newcomer = await createProfessional("upgrade-newcomer");
    // The fixture grants test professionals their access: take it back, as
    // for an account made directly with Auth.
    await db.query("delete from private.beta_access where user_id = $1", [
      newcomer.userId,
    ]);
    await expect(
      completeOnboarding(newcomer.client, input()),
    ).rejects.toMatchObject({
      code: "beta_invitation_required",
    });
  });
});
