import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  generateTeamInviteToken,
  hashTeamInviteToken,
  type TeamDto,
  type TeamMemberDto,
} from "@/features/team/data/team";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Her team (docs/TEAM_CONTRACT.md) through PostgREST with real sessions:
// the owner, an admin who joined by invitation, and another business's
// owner who knows every UUID.

type Rpc = { data: unknown; error: { message: string } | null };

async function call(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Rpc> {
  const { data, error } = await (
    client.rpc as unknown as (f: string, a: object) => Promise<Rpc>
  )(fn, args);
  return { data, error };
}

async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

async function refusal(promise: Promise<Rpc>): Promise<string | undefined> {
  return (await promise).error?.message;
}

const readTeam = (client: AppSupabaseClient, business: TestBusiness) =>
  ok<TeamDto>(call(client, "get_team", { p_business_id: business.id }));

function invite(
  client: AppSupabaseClient,
  business: TestBusiness,
  member: TeamMemberDto,
  email: string,
  options: { role?: string; operationId?: string; token?: string } = {},
) {
  return call(client, "send_team_invitation", {
    p_business_id: business.id,
    p_operation_id: options.operationId ?? randomUUID(),
    p_staff_id: member.id,
    p_expected_revision: member.revision,
    p_email: email,
    p_role: options.role ?? "admin",
    p_token_hash: hashTeamInviteToken(
      options.token ?? generateTeamInviteToken(),
    ),
  });
}

let owner: Professional;
let stranger: Professional;
let business: TestBusiness;
let otherBusiness: TestBusiness;
let serviceA: string;
let serviceB: string;

beforeAll(async () => {
  owner = await createProfessional("team-owner");
  stranger = await createProfessional("team-stranger");
  business = await createBusiness(owner.userId);
  otherBusiness = await createBusiness(stranger.userId);
  serviceA = await createService(business.id, { name: "Pose" });
  serviceB = await createService(business.id, { name: "Rehaussement" });
});

describe("team", () => {
  it("gives the owner a bookable profile with every service", async () => {
    const team = await readTeam(owner.client, business);
    expect(team.members).toHaveLength(1);
    const [me] = team.members;
    expect(me).toMatchObject({
      bookable: true,
      access: { role: "owner", email: owner.email },
      invite: null,
      upcomingAppointments: 0,
    });
    expect(me!.serviceIds.toSorted()).toEqual([serviceA, serviceB].toSorted());
    expect(team.services.map((s) => s.id).toSorted()).toEqual(
      [serviceA, serviceB].toSorted(),
    );
  });

  it("creates a profile once per operationId", async () => {
    const operationId = randomUUID();
    const args = {
      p_business_id: business.id,
      p_operation_id: operationId,
      p_display_name: "  Léa  ",
      p_bookable: true,
      p_service_ids: [serviceA, serviceA],
    };
    const first = await ok<TeamMemberDto>(
      call(owner.client, "create_staff_member", args),
    );
    expect(first).toMatchObject({
      displayName: "Léa",
      bookable: true,
      serviceIds: [serviceA],
      access: null,
      revision: 1,
    });
    const replay = await ok<TeamMemberDto>(
      call(owner.client, "create_staff_member", args),
    );
    expect(replay).toEqual(first);
    expect(
      await refusal(
        call(owner.client, "create_staff_member", {
          ...args,
          p_display_name: "Autre",
        }),
      ),
    ).toBe("idempotency_conflict");
    const { rows } = await db.query(
      "select count(*)::int as n from public.staff_members where business_id = $1 and display_name = 'Léa'",
      [business.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses a stale revision and a service of another business", async () => {
    const member = await ok<TeamMemberDto>(
      call(owner.client, "create_staff_member", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_display_name: "Inès",
        p_bookable: false,
        p_service_ids: [],
      }),
    );
    const update = (revision: number, serviceIds: string[]) =>
      call(owner.client, "update_staff_member", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_staff_id: member.id,
        p_expected_revision: revision,
        p_display_name: "Inès B.",
        p_bookable: true,
        p_service_ids: serviceIds,
      });
    const updated = await ok<TeamMemberDto>(update(1, [serviceB]));
    expect(updated).toMatchObject({
      revision: 2,
      bookable: true,
      serviceIds: [serviceB],
    });
    expect(await refusal(update(1, [serviceB]))).toBe("version_conflict");
    const foreign = await createService(otherBusiness.id);
    expect(await refusal(update(2, [foreign]))).toBe("invalid_input");
  });

  it("keeps a person with upcoming appointments bookable", async () => {
    const [me] = (await readTeam(owner.client, business)).members;
    const client = await createClientRecord(
      business.id,
      `c-${randomUUID()}@test.local`,
    );
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    await insertAppointment({
      businessId: business.id,
      clientId: client,
      serviceId: serviceA,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    });
    // Several bookable profiles now: the appointment was not guessed onto one.
    const { rows } = await db.query(
      "select staff_id from public.appointments where business_id = $1",
      [business.id],
    );
    expect(rows[0].staff_id).toBeNull();
    await db.query(
      "update public.appointments set staff_id = $1 where business_id = $2",
      [me!.id, business.id],
    );

    const fresh = (await readTeam(owner.client, business)).members[0]!;
    expect(fresh.upcomingAppointments).toBe(1);
    expect(
      await refusal(
        call(owner.client, "update_staff_member", {
          p_business_id: business.id,
          p_operation_id: randomUUID(),
          p_staff_id: fresh.id,
          p_expected_revision: fresh.revision,
          p_display_name: fresh.displayName,
          p_bookable: false,
          p_service_ids: fresh.serviceIds,
        }),
      ),
    ).toBe("upcoming_appointments");
  });

  it("invites, replaces the previous invitation, and lets the invited admin in", async () => {
    let member = await ok<TeamMemberDto>(
      call(owner.client, "create_staff_member", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_display_name: "Admin invitée",
        p_bookable: false,
        p_service_ids: [],
      }),
    );
    const invited = await createProfessional("team-invited");

    expect(
      await refusal(
        invite(owner.client, business, member, invited.email, {
          role: "practitioner",
        }),
      ),
    ).toBe("role_unavailable");

    const firstToken = generateTeamInviteToken();
    member = await ok<TeamMemberDto>(
      invite(owner.client, business, member, invited.email, {
        token: firstToken,
      }),
    );
    expect(member.invite).toMatchObject({
      status: "pending",
      role: "admin",
      email: invited.email,
    });
    expect(JSON.stringify(member)).not.toContain(
      hashTeamInviteToken(firstToken),
    );

    const secondToken = generateTeamInviteToken();
    member = await ok<TeamMemberDto>(
      invite(owner.client, business, member, invited.email, {
        token: secondToken,
      }),
    );

    // The first link no longer works; someone else's account is refused.
    expect(
      await refusal(
        call(invited.client, "accept_team_invitation", {
          p_token_hash: hashTeamInviteToken(firstToken),
        }),
      ),
    ).toBe("invitation_invalid");
    const intruder = await createProfessional("team-intruder");
    expect(
      await refusal(
        call(intruder.client, "accept_team_invitation", {
          p_token_hash: hashTeamInviteToken(secondToken),
        }),
      ),
    ).toBe("invitation_email_mismatch");

    expect(
      await ok(
        call(invited.client, "accept_team_invitation", {
          p_token_hash: hashTeamInviteToken(secondToken),
        }),
      ),
    ).toBe(business.id);
    expect(
      await refusal(
        call(invited.client, "accept_team_invitation", {
          p_token_hash: hashTeamInviteToken(secondToken),
        }),
      ),
    ).toBe("invitation_invalid");

    const joined = (await readTeam(owner.client, business)).members.find(
      (m) => m.id === member.id,
    )!;
    expect(joined).toMatchObject({
      access: { role: "admin", email: invited.email },
      invite: { status: "accepted" },
    });

    // An admin edits profiles but neither invites nor removes the owner.
    const adminView = await readTeam(invited.client, business);
    expect(adminView.members.length).toBeGreaterThan(1);
    const ownerProfile = adminView.members.find(
      (m) => m.access?.role === "owner",
    )!;
    expect(
      await refusal(
        call(invited.client, "revoke_team_access", {
          p_business_id: business.id,
          p_operation_id: randomUUID(),
          p_staff_id: ownerProfile.id,
          p_expected_revision: ownerProfile.revision,
        }),
      ),
    ).toBe("permission_denied");
    const spare = await ok<TeamMemberDto>(
      call(invited.client, "create_staff_member", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_display_name: "Profil d'admin",
        p_bookable: false,
        p_service_ids: [],
      }),
    );
    expect(
      await refusal(
        invite(invited.client, business, spare, `x-${randomUUID()}@test.local`),
      ),
    ).toBe("permission_denied");

    // The owner takes the access away: the profile stays, the account leaves.
    const revoked = await ok<TeamMemberDto>(
      call(owner.client, "revoke_team_access", {
        p_business_id: business.id,
        p_operation_id: randomUUID(),
        p_staff_id: joined.id,
        p_expected_revision: joined.revision,
      }),
    );
    expect(revoked).toMatchObject({
      access: null,
      displayName: "Admin invitée",
    });
    expect(
      await refusal(
        call(invited.client, "get_team", { p_business_id: business.id }),
      ),
    ).toBe("forbidden");
  });

  it("never removes the last owner", async () => {
    const me = (await readTeam(owner.client, business)).members.find(
      (m) => m.access?.role === "owner",
    )!;
    expect(
      await refusal(
        call(owner.client, "revoke_team_access", {
          p_business_id: business.id,
          p_operation_id: randomUUID(),
          p_staff_id: me.id,
          p_expected_revision: me.revision,
        }),
      ),
    ).toBe("last_owner");
  });

  it("answers another business as if nothing existed", async () => {
    // Validation never runs before access: the victim's service ids are not
    // probed.
    for (const ids of [[serviceA], [randomUUID()]]) {
      expect(
        await refusal(
          call(stranger.client, "create_staff_member", {
            p_business_id: business.id,
            p_operation_id: randomUUID(),
            p_display_name: "Intruse",
            p_bookable: true,
            p_service_ids: ids,
          }),
        ),
      ).toBe("forbidden");
    }
    const theirs = (await readTeam(stranger.client, otherBusiness)).members[0]!;
    expect(
      await refusal(
        call(stranger.client, "get_team", { p_business_id: business.id }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        call(owner.client, "update_staff_member", {
          p_business_id: business.id,
          p_operation_id: randomUUID(),
          p_staff_id: theirs.id,
          p_expected_revision: theirs.revision,
          p_display_name: "Pris",
          p_bookable: true,
          p_service_ids: [],
        }),
      ),
    ).toBe("not_found");
    const { error } = await owner.client
      .from("staff_members")
      .select("id")
      .eq("id", theirs.id);
    expect(error).toBeNull();
    const { data } = await owner.client
      .from("staff_members")
      .select("id")
      .eq("business_id", otherBusiness.id);
    expect(data).toEqual([]);
  });
});
