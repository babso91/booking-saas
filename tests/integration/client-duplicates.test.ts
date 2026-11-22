import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  generateTeamInviteToken,
  hashTeamInviteToken,
  type TeamMemberDto,
} from "@/features/team/data/team";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  createBusiness,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Point 147 (Higani backlog): two records that look alike are proposed for
// her to check, never merged. Same phone (normalised) or same full name
// (accents, case, hyphens aside); she can say they are two people.

type Summary = {
  id: string;
  firstName: string;
  lastName: string | null;
  pastVisits: number;
  upcoming: number;
  lastVisitAt: string | null;
};
type Candidates = {
  total: number;
  pairs: { reasons: string[]; clients: [Summary, Summary] }[];
};

let owner: Professional;
let business: TestBusiness;
let service: string;
const ids: Record<string, string> = {};

async function call<T>(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await client.rpc(fn as never, args as never);
  return { data: data as T, error };
}
async function ok<T>(promise: Promise<{ data: T; error: unknown }>) {
  const { data, error } = await promise;
  expect(error).toBeNull();
  return data;
}

async function client(
  businessId: string,
  firstName: string,
  lastName: string | null,
  phone: string | null,
  email: string | null = null,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.clients (business_id, first_name, last_name, phone, email)
     values ($1, $2, $3, $4, $5) returning id`,
    [businessId, firstName, lastName, phone, email],
  );
  return rows[0]!.id;
}

const candidates = (who = owner.client, b = business) =>
  call<Candidates>(who, "crm_duplicate_candidates", { p_business_id: b.id });
const dismiss = (a: string, b: string, dismissed = true, who = owner.client) =>
  call(who, "crm_set_duplicate_dismissed", {
    p_business_id: business.id,
    p_client_id: a,
    p_other_id: b,
    p_dismissed: dismissed,
  });
/** Each pair as the names she sees, in order. */
const named = (result: Candidates) =>
  result.pairs.map((pair) => ({
    reasons: pair.reasons,
    names: pair.clients
      .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" "))
      .sort(),
  }));

beforeAll(async () => {
  owner = await createProfessional("duplicates");
  business = await createBusiness(owner.userId);
  service = await createService(business.id, { name: "Coupe" });
  // The same person, who changed her address: same phone, same name.
  ids.ines = await client(
    business.id,
    "Inès",
    "Le Gall",
    "+33 6 12 34 56 78",
    "ines@client.test",
  );
  ids.ines2 = await client(
    business.id,
    "ines",
    "le-gall",
    "06 12 34 56 78",
    "ines.legall@client.test",
  );
  // Two people sharing a phone (a family): phone only.
  ids.paul = await client(business.id, "Paul", "Martin", "07.11.11.11.11");
  ids.lea = await client(business.id, "Léa", "Bernard", "0711111111");
  // Same name, nothing else: name only.
  ids.marie = await client(business.id, "Marie", "Dupont", "0700000001");
  ids.marie2 = await client(business.id, "Marie", "Dupont", null);
  // A first name alone is not enough; a short number is not compared.
  await client(business.id, "Zoé", null, "12");
  await client(business.id, "Zoé", null, "12");
  // An erased record is never proposed.
  const erased = await client(
    business.id,
    "Cliente effacée",
    null,
    "0711111111",
  );
  await db.query("update public.clients set erased_at = now() where id = $1", [
    erased,
  ]);

  // Inès's visits, to tell her records apart.
  await insertAppointment({
    businessId: business.id,
    clientId: ids.ines,
    serviceId: service,
    startsAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() - 20 * 86_400_000 + 3_600_000).toISOString(),
    status: "completed",
  });
  await insertAppointment({
    businessId: business.id,
    clientId: ids.ines,
    serviceId: service,
    startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString(),
  });
});

describe("point 147: records that look alike, for her to check", () => {
  it("proposes them strongest first, with what tells them apart; never merges", async () => {
    const before = await db.query(
      "select count(*)::int as n from public.clients where business_id = $1",
      [business.id],
    );
    const result = await ok(candidates());
    expect(result.total).toBe(3);
    expect(named(result)).toEqual([
      { reasons: ["phone", "name"], names: ["Inès Le Gall", "ines le-gall"] },
      { reasons: ["phone"], names: ["Léa Bernard", "Paul Martin"] },
      { reasons: ["name"], names: ["Marie Dupont", "Marie Dupont"] },
    ]);
    const ines = result.pairs[0]!.clients.find((c) => c.id === ids.ines)!;
    expect(ines).toMatchObject({ pastVisits: 1, upcoming: 1 });
    expect(ines.lastVisitAt).not.toBeNull();
    expect(ines).toHaveProperty("email", "ines@client.test");

    const after = await db.query(
      "select count(*)::int as n from public.clients where business_id = $1",
      [business.id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("« not the same person » is remembered, both ways, and can be undone", async () => {
    await ok(dismiss(ids.lea!, ids.paul!));
    await ok(dismiss(ids.paul!, ids.lea!)); // again, the other way round
    let result = await ok(candidates());
    expect(result.total).toBe(2);
    expect(named(result).map((pair) => pair.names)).not.toContainEqual([
      "Léa Bernard",
      "Paul Martin",
    ]);

    await ok(dismiss(ids.paul!, ids.lea!, false));
    result = await ok(candidates());
    expect(result.total).toBe(3);
  });

  it("50 pairs at most, with the total", async () => {
    const other = await createProfessional("duplicates-many");
    const crowded = await createBusiness(other.userId);
    await db.query(
      `insert into public.clients (business_id, first_name, phone)
       select $1, 'Cliente ' || n || side, '06' || lpad(n::text, 8, '0')
       from generate_series(1, 60) n, (values ('a'), ('b')) s(side)`,
      [crowded.id],
    );
    const result = await ok(candidates(other.client, crowded));
    expect(result.total).toBe(60);
    expect(result.pairs).toHaveLength(50);
  });

  it("her business only; owner or admin; checked input", async () => {
    // The same phone in another business is someone else's record.
    const other = await createProfessional("duplicates-other");
    const elsewhere = await createBusiness(other.userId);
    const theirs = await client(elsewhere.id, "Inès", "Le Gall", "0612345678");
    expect((await ok(candidates(other.client, elsewhere))).total).toBe(0);
    expect((await candidates(other.client)).error?.message).toBe("forbidden");
    expect((await dismiss(ids.ines!, theirs)).error?.message).toBe(
      "client_not_found",
    );
    expect((await dismiss(ids.ines!, ids.ines!)).error?.message).toBe(
      "invalid_input",
    );
    // Her choices are hers: another business reads none of them (RLS).
    await ok(dismiss(ids.lea!, ids.paul!));
    const peek = await other.client
      .from("client_duplicate_dismissals" as never)
      .select("*");
    expect(peek.data).toEqual([]);
    await ok(dismiss(ids.lea!, ids.paul!, false));

    const member = await ok<TeamMemberDto>(
      call(owner.client, "create_staff_member", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_display_name: "Sam",
        p_bookable: true,
        p_service_ids: [service],
      }),
    );
    const sam = await createProfessional("duplicates-practitioner");
    const token = generateTeamInviteToken();
    await ok(
      call(owner.client, "send_team_invitation", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_staff_id: member.id,
        p_expected_revision: member.revision,
        p_email: sam.email,
        p_role: "practitioner",
        p_token_hash: hashTeamInviteToken(token),
      }),
    );
    await ok(
      call(sam.client, "accept_team_invitation", {
        p_token_hash: hashTeamInviteToken(token),
      }),
    );
    expect((await candidates(sam.client)).error?.message).toBe("forbidden");
    expect(
      (await dismiss(ids.lea!, ids.paul!, true, sam.client)).error?.message,
    ).toBe("forbidden");
  });
});
