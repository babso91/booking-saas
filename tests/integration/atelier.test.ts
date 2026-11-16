import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  createBusiness,
  createProfessional,
  db,
  env,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// The Atelier, her side (docs/ATELIER_CONTRACT.md): the owner through
// PostgREST, the platform and its operator through the service.

const service = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
}) as AppSupabaseClient;

type Rpc = { data: unknown; error: { message: string; hint?: string } | null };
const call = (client: AppSupabaseClient, fn: string, args: object) =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

type View = {
  order: {
    status: string;
    correctionsUsed: number;
    quote: { includedCorrections: number };
  };
  proposals: { proposalId: string; state: string; rebaseRequested: boolean }[];
  currentDraftRevision: number;
};

let owner: Professional;
let business: TestBusiness;

async function order(includedCorrections = 1) {
  const orderId = await ok<string>(
    call(service, "atelier_create_order", {
      p_business_id: business.id,
      p_title: "Refonte de la vitrine",
      p_amount_cents: 14900,
      p_included_corrections: includedCorrections,
      p_scopes: ["texts", "layout"],
    }),
  );
  const grantId = await ok<string>(
    call(service, "atelier_grant_operator", {
      p_order_id: orderId,
      p_operator_label: "Atelier Booking",
      p_days: 14,
    }),
  );
  return { orderId, grantId };
}

const propose = (grantId: string, base: number, name: string) =>
  ok<string>(
    call(service, "atelier_submit_proposal", {
      p_grant_id: grantId,
      p_base_draft_revision: base,
      p_schema_version: 1,
      p_config: { name },
      p_changes: [`Titre : ${name}`],
    }),
  );

const read = (orderId: string, who = owner) =>
  call(who.client, "atelier_read", { p_order_id: orderId });

const site = async () =>
  (
    await db.query(
      "select draft_revision, draft_config, published_version_id from public.sites where business_id = $1",
      [business.id],
    )
  ).rows[0];

beforeAll(async () => {
  owner = await createProfessional("atelier-owner");
  business = await createBusiness(owner.userId);
});

describe("applying a proposal", () => {
  it("saves her draft through the Studio's path, never publishes, and replays", async () => {
    const { orderId, grantId } = await order();
    const proposalId = await propose(grantId, 0, "Atelier A");
    const view = await ok<View>(read(orderId));
    expect(view).toMatchObject({
      order: { status: "in_review" },
      currentDraftRevision: 0,
    });
    expect(view.proposals.map((p) => p.state)).toEqual(["submitted"]);

    const requestId = randomUUID();
    const apply = () =>
      call(owner.client, "atelier_apply", {
        p_proposal_id: proposalId,
        p_expected_draft_revision: 0,
        p_request_id: requestId,
      });
    expect(await ok(apply())).toEqual({ draftRevision: 1 });
    expect(await ok(apply())).toEqual({ draftRevision: 1 });
    expect(await site()).toMatchObject({
      draft_revision: 1,
      draft_config: { name: "Atelier A" },
      published_version_id: null,
    });
  });

  it("refuses a proposal made on another draft: nothing overwritten, her revision said", async () => {
    const { grantId } = await order();
    const base = (await site()).draft_revision as number;
    const proposalId = await propose(grantId, base, "Atelier B");
    // She edits her draft herself meanwhile (the Studio).
    await db.query("select public.save_site_draft($1, $2, $3, 1, $4)", [
      business.id,
      owner.userId,
      base,
      JSON.stringify({ name: "Elle-même" }),
    ]);
    const refused = await call(owner.client, "atelier_apply", {
      p_proposal_id: proposalId,
      p_expected_draft_revision: base + 1,
      p_request_id: randomUUID(),
    });
    expect(refused.error).toMatchObject({
      message: "stale_site_draft",
      hint: String(base + 1),
    });
    expect((await site()).draft_config).toEqual({ name: "Elle-même" });
  });
});

describe("corrections", () => {
  it("counts once per request, within the quote's scopes and its included corrections", async () => {
    const { orderId, grantId } = await order(1);
    const proposalId = await propose(
      grantId,
      (await site()).draft_revision,
      "Atelier C",
    );
    const correction = (scope: string, requestId = randomUUID()) =>
      call(owner.client, "atelier_request_correction", {
        p_proposal_id: proposalId,
        p_scope: scope,
        p_request_id: requestId,
      });

    expect((await correction("photos")).error?.message).toBe(
      "atelier_out_of_scope",
    );
    const requestId = randomUUID();
    await ok(correction("texts", requestId));
    await ok(correction("texts", requestId)); // a retry: counted once
    expect((await ok<View>(read(orderId))).order.correctionsUsed).toBe(1);
    expect((await correction("layout")).error?.message).toBe(
      "atelier_revision_limit_reached",
    );

    // Remade on her current draft: never a correction.
    const rebased = await ok<View>(
      call(owner.client, "atelier_request_rebase", {
        p_proposal_id: proposalId,
        p_request_id: randomUUID(),
      }),
    );
    expect(rebased.order.correctionsUsed).toBe(1);
    expect(rebased.proposals[0]).toMatchObject({ rebaseRequested: true });
  });
});

describe("access", () => {
  it("an expired operator, another business, or an admin sees nothing", async () => {
    const { orderId, grantId } = await order();
    await db.query(
      "update private.atelier_operator_grants set expires_at = now() - interval '1 second' where id = $1",
      [grantId],
    );
    expect(
      (
        await call(service, "atelier_submit_proposal", {
          p_grant_id: grantId,
          p_base_draft_revision: 0,
          p_schema_version: 1,
          p_config: { name: "Trop tard" },
          p_changes: ["x"],
        })
      ).error?.message,
    ).toBe("atelier_access_expired");

    const stranger = await createProfessional("atelier-stranger");
    await createBusiness(stranger.userId);
    expect((await read(orderId, stranger)).error?.message).toBe(
      "atelier_access_expired",
    );

    const admin = await createProfessional("atelier-admin");
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $2, 'admin')",
      [business.id, admin.userId],
    );
    expect((await read(orderId, admin)).error?.message).toBe(
      "atelier_access_expired",
    );
    // Only the service creates orders and proposals.
    expect(
      (
        await call(owner.client, "atelier_create_order", {
          p_business_id: business.id,
          p_title: "x",
          p_amount_cents: 0,
          p_included_corrections: 0,
          p_scopes: [],
        })
      ).error,
    ).not.toBeNull();
  });
});
