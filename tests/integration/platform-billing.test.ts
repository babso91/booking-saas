import { createHmac, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as postEvent } from "@/app/api/billing/events/route";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  anonClient,
  createBusiness,
  createProfessional,
  db,
  env,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Her plan and billing, simulated (docs/PLATFORM_BILLING_CONTRACT.md): the
// owner through PostgREST, billing events through the service and the
// signed webhook. No right ever moves without a verified payment.

const service = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
}) as AppSupabaseClient;

type Rpc = { data: unknown; error: { message: string } | null };
const call = (client: AppSupabaseClient, fn: string, args: object) =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);
async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

type Summary = {
  plan: string;
  cadence: string;
  state: string;
  revision: number;
  cancellation: { effectiveAt: string } | null;
  graceUntil: string | null;
  pending: { commandId: string; status: string } | null;
  simulated: boolean;
};
type Quote = {
  quoteId: string;
  dueNowMinor: number;
  nextCharge: { amountMinor: number };
  effective: { mode: string; at?: string };
  revision: number;
};

let owner: Professional;
let business: TestBusiness;

const summary = () =>
  ok<Summary>(
    call(owner.client, "platform_billing_summary", {
      p_business_id: business.id,
    }),
  );
const quote = (
  plan: string,
  cadence: string,
  revision: number,
  promo?: string,
) =>
  call(owner.client, "platform_quote_change", {
    p_business_id: business.id,
    p_target_plan: plan,
    p_target_cadence: cadence,
    p_expected_revision: revision,
    p_promo_code: promo ?? null,
  });
const confirm = (
  quoteId: string,
  revision: number,
  operationId = randomUUID(),
) =>
  call(owner.client, "platform_confirm_change", {
    p_business_id: business.id,
    p_quote_id: quoteId,
    p_expected_revision: revision,
    p_operation_id: operationId,
  });
const ingest = (event: Record<string, unknown>) =>
  ok<string>(call(service, "platform_ingest_event", { p_event: event }));
const sitePlan = async () =>
  (
    await db.query("select plan from public.sites where business_id = $1", [
      business.id,
    ])
  ).rows[0]?.plan ?? "core";
const invoices = () =>
  ok<{ amountMinor: number; simulated: boolean }[]>(
    call(owner.client, "platform_list_invoices", {
      p_business_id: business.id,
    }),
  );

/** A paying subscription (source billing) at this price version. */
async function paying(
  priceVersionId: string,
  plan: string,
  cadence = "monthly",
) {
  await summary();
  await db.query("select public.set_site_plan($1, $2)", [business.id, plan]);
  await db.query(
    `update private.platform_subscriptions
     set source = 'billing', plan = $2, cadence = $3, price_version_id = $4,
         current_period_start = now() - interval '15 days',
         current_period_end = now() + interval '15 days'
     where business_id = $1`,
    [business.id, plan, cadence, priceVersionId],
  );
}

async function freshBusiness() {
  owner = await createProfessional("billing-owner");
  business = await createBusiness(owner.userId);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  await freshBusiness();
});

describe("offers and summary", () => {
  it("lists the immutable price versions to anyone; her summary starts from the captured state", async () => {
    const { data } = await anonClient().rpc("platform_list_offers" as never);
    const offers = (
      data as unknown as {
        offers: { priceVersionId: string; amountMinor: number }[];
      }
    ).offers;
    expect(
      Object.fromEntries(offers.map((o) => [o.priceVersionId, o.amountMinor])),
    ).toEqual({
      core_m_v1: 2900,
      core_y_v1: 29000,
      sig_m_v1: 4900,
      sig_y_v1: 49000,
    });
    await expect(
      db.query(
        "update private.platform_price_versions set amount_minor = 1 where id = 'core_m_v1'",
      ),
    ).rejects.toThrow(/price_version_immutable/);
    // Every price is provisional (the commercial model is not decided).
    expect(
      (
        data as unknown as {
          offers: { provisional: boolean; perBookableStaff: unknown }[];
        }
      ).offers.every((o) => o.provisional && o.perBookableStaff === null),
    ).toBe(true);
    // A version may carry a per-professional component (none does today):
    // one bookable professional is counted, the included one costs nothing.
    await db.query(
      `insert into private.platform_price_versions
         (id, plan, cadence, amount_minor, included_bookable_staff, extra_staff_amount_minor, active)
       values ('test_staff_v1', 'core', 'monthly', 2900, 1, 700, false)
       on conflict (id) do nothing`,
    );
    const { rows } = await db.query(
      "select private.platform_price_amount('test_staff_v1', $1) as amount",
      [business.id],
    );
    expect(rows[0].amount).toBe(2900);
    // With none included, her one bookable professional is charged on top.
    await db.query(
      `insert into private.platform_price_versions
         (id, plan, cadence, amount_minor, included_bookable_staff, extra_staff_amount_minor, active)
       values ('test_staff_v0', 'core', 'monthly', 2900, 0, 700, false)
       on conflict (id) do nothing`,
    );
    const extra = await db.query(
      "select private.platform_price_amount('test_staff_v0', $1) as amount",
      [business.id],
    );
    expect(extra.rows[0].amount).toBe(3600);

    expect(await summary()).toMatchObject({
      plan: "core",
      cadence: "monthly",
      state: "active",
      pending: null,
      simulated: true,
    });
  });
});

describe("plan change", () => {
  it("grants nothing before the verified payment of the quoted amount", async () => {
    await freshBusiness();
    const before = await summary();
    const q = await ok<Quote>(quote("signature", "monthly", before.revision));
    expect(q).toMatchObject({
      dueNowMinor: 4900,
      nextCharge: { amountMinor: 4900 },
      effective: { mode: "after_verified_payment" },
    });
    const operationId = randomUUID();
    const command = await ok<{ commandId: string; status: string }>(
      confirm(q.quoteId, before.revision, operationId),
    );
    expect(command.status).toBe("requested");
    expect(await ok(confirm(q.quoteId, before.revision, operationId))).toEqual(
      command,
    );
    expect(await sitePlan()).toBe("core");
    // Another tab, the old revision: refused.
    expect(
      (await quote("signature", "yearly", before.revision)).error?.message,
    ).toBe("billing_state_changed");

    // Not the quoted amount: rejected, nothing granted.
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "payment_succeeded",
        commandId: command.commandId,
        amountMinor: 100,
        sourceVersion: 1,
      }),
    ).toBe("staged");
    expect(await sitePlan()).toBe("core");

    const paid = {
      eventId: `evt_${randomUUID()}`,
      kind: "payment_succeeded",
      commandId: command.commandId,
      amountMinor: 4900,
      sourceVersion: 2,
    };
    expect(await ingest(paid)).toBe("applied");
    expect(await ingest(paid)).toBe("applied"); // redelivered: neutral
    expect(await sitePlan()).toBe("signature");
    expect(await invoices()).toEqual([
      expect.objectContaining({
        amountMinor: 4900,
        simulated: true,
        status: "issued",
      }),
    ]);
    // An older event for the same command is ignored.
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "payment_failed",
        commandId: command.commandId,
        sourceVersion: 1,
      }),
    ).toBe("ignored_stale");
    expect((await summary()).plan).toBe("signature");
  });

  it("prorates an upgrade over the rest of the paid period: 1000 now, then 4900 a month", async () => {
    await freshBusiness();
    await summary();
    await db.query(
      `update private.platform_subscriptions
       set source = 'billing', price_version_id = 'core_m_v1',
           current_period_start = now() - interval '15 days',
           current_period_end = now() + interval '15 days'
       where business_id = $1`,
      [business.id],
    );
    const q = await ok<Quote>(
      quote("signature", "monthly", (await summary()).revision),
    );
    expect(q.dueNowMinor).toBe(1000);
    expect(q.nextCharge.amountMinor).toBe(4900);
  });

  it("schedules a downgrade, applied only at a renewal paid at the new price", async () => {
    await freshBusiness();
    await paying("sig_m_v1", "signature");
    let s = await summary();
    const down = await ok<Quote>(quote("core", "monthly", s.revision));
    expect(down).toMatchObject({
      dueNowMinor: 0,
      effective: { mode: "end_of_period" },
    });
    const scheduled = await ok<{ commandId: string; status: string }>(
      confirm(down.quoteId, s.revision),
    );
    expect(scheduled.status).toBe("scheduled");
    const renewal = (amountMinor: number, sourceVersion: number) =>
      ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "renewal_succeeded",
        businessId: business.id,
        amountMinor,
        sourceVersion,
      });
    expect(await renewal(4900, 1)).toBe("rejected");
    expect(await sitePlan()).toBe("signature");
    expect(await renewal(2900, 2)).toBe("applied");
    expect(await sitePlan()).toBe("core");
    s = await summary();
    expect(s.pending).toBeNull();
  });

  it("an upgrade to another cadence is paid in full first; a change waiting for payment can be cancelled, a late payment is staged", async () => {
    await freshBusiness();
    await paying("core_m_v1", "core");
    let s = await summary();
    // Core monthly → Signature yearly: never at the end of the period.
    const up = await ok<Quote>(quote("signature", "yearly", s.revision));
    expect(up).toMatchObject({
      dueNowMinor: 49000,
      effective: { mode: "after_verified_payment" },
    });
    const command = await ok<{ commandId: string }>(
      confirm(up.quoteId, s.revision),
    );
    await ok(
      call(owner.client, "platform_cancel_scheduled", {
        p_business_id: business.id,
        p_command_id: command.commandId,
        p_operation_id: randomUUID(),
      }),
    );
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "payment_succeeded",
        commandId: command.commandId,
        amountMinor: 49000,
        sourceVersion: 1,
      }),
    ).toBe("staged");
    expect(await sitePlan()).toBe("core");

    s = await summary();
    const again = await ok<Quote>(quote("signature", "yearly", s.revision));
    const second = await ok<{ commandId: string }>(
      confirm(again.quoteId, s.revision),
    );
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "payment_failed",
        commandId: second.commandId,
        sourceVersion: 1,
      }),
    ).toBe("applied");
    expect(await sitePlan()).toBe("core");
    expect((await summary()).pending).toBeNull();

    // A request whose payment never comes lapses.
    s = await summary();
    const third = await ok<Quote>(quote("signature", "monthly", s.revision));
    const waiting = await ok<{ commandId: string }>(
      confirm(third.quoteId, s.revision),
    );
    await db.query(
      "update private.platform_change_commands set expires_at = now() - interval '1 second' where id = $1",
      [waiting.commandId],
    );
    await ok(call(service, "platform_run_due", {}));
    expect((await summary()).pending).toBeNull();
  });

  it("refuses an expired quote, another business's quote, a promo code, and a non-owner", async () => {
    await freshBusiness();
    const s = await summary();
    const q = await ok<Quote>(quote("signature", "monthly", s.revision));
    await db.query(
      "update private.platform_quotes set expires_at = now() - interval '1 second' where id = $1",
      [q.quoteId],
    );
    expect((await confirm(q.quoteId, s.revision)).error?.message).toBe(
      "quote_expired",
    );
    expect(
      (await quote("signature", "monthly", s.revision, "BIENVENUE")).error
        ?.message,
    ).toBe("promo_unavailable");

    const otherOwner = await createProfessional("billing-other");
    const other = await createBusiness(otherOwner.userId);
    const theirs = await ok<Quote>(
      call(otherOwner.client, "platform_quote_change", {
        p_business_id: other.id,
        p_target_plan: "signature",
        p_target_cadence: "monthly",
        p_expected_revision: 1,
        p_promo_code: null,
      }),
    );
    expect((await confirm(theirs.quoteId, s.revision)).error?.message).toBe(
      "quote_expired",
    );

    const admin = await createProfessional("billing-admin");
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $2, 'admin')",
      [business.id, admin.userId],
    );
    expect(
      (
        await call(admin.client, "platform_quote_change", {
          p_business_id: business.id,
          p_target_plan: "signature",
          p_target_cadence: "monthly",
          p_expected_revision: s.revision,
          p_promo_code: null,
        })
      ).error?.message,
    ).toBe("permission_denied");
    // She may read the summary.
    expect(
      (
        await call(admin.client, "platform_billing_summary", {
          p_business_id: business.id,
        })
      ).error,
    ).toBeNull();
  });
});

describe("renewal and cancellation", () => {
  it("keeps her plan until the end of a cancelled period, then returns to Core", async () => {
    await freshBusiness();
    await db.query("select public.set_site_plan($1, 'signature')", [
      business.id,
    ]);
    let s = await summary();
    const cancel = (fn: string, revision: number) =>
      call(owner.client, fn, {
        p_business_id: business.id,
        p_expected_revision: revision,
        p_operation_id: randomUUID(),
      });
    const requested = await ok<{ summary: Summary }>(
      cancel("platform_request_cancellation", s.revision),
    );
    expect(requested.summary).toMatchObject({
      state: "active",
      plan: "signature",
    });
    expect(requested.summary.cancellation).not.toBeNull();
    s = await ok<Summary>(
      cancel("platform_undo_cancellation", requested.summary.revision),
    );
    expect(s.cancellation).toBeNull();
    s = (
      await ok<{ summary: Summary }>(
        cancel("platform_request_cancellation", s.revision),
      )
    ).summary;

    await db.query(
      "update private.platform_subscriptions set cancel_at = now() - interval '1 second' where business_id = $1",
      [business.id],
    );
    await ok(call(service, "platform_run_due", {}));
    expect(await summary()).toMatchObject({ state: "ended", plan: "core" });
    // Starting again is a first payment, whatever was paid before.
    const back = await ok<Quote>(
      quote("signature", "monthly", (await summary()).revision),
    );
    expect(back).toMatchObject({
      dueNowMinor: 4900,
      effective: { mode: "after_verified_payment" },
    });
  });

  it("a failed renewal keeps her rights during the grace; events out of order are ignored", async () => {
    await freshBusiness();
    // Nothing to renew from the legacy state: staged.
    await summary();
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "renewal_succeeded",
        businessId: business.id,
        amountMinor: 2900,
        sourceVersion: 1,
      }),
    ).toBe("staged");
    await paying("core_m_v1", "core");
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "renewal_succeeded",
        businessId: business.id,
        amountMinor: 2900,
        sourceVersion: 3,
      }),
    ).toBe("applied");
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "renewal_failed",
        businessId: business.id,
        sourceVersion: 2,
      }),
    ).toBe("ignored_stale");
    expect((await summary()).state).toBe("active");
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "renewal_failed",
        businessId: business.id,
        sourceVersion: 4,
        graceDays: 7,
      }),
    ).toBe("applied");
    const s = await summary();
    expect(s.state).toBe("past_due");
    expect(s.graceUntil).not.toBeNull();
    // Unknown object: staged for reconciliation, never applied.
    expect(
      await ingest({
        eventId: `evt_${randomUUID()}`,
        kind: "renewal_succeeded",
        businessId: randomUUID(),
        sourceVersion: 1,
      }),
    ).toBe("staged");
  });
});

describe("billing webhook", () => {
  it("refuses everything without its secret, a bad signature, and records a signed event", async () => {
    const event = JSON.stringify({
      eventId: `evt_${randomUUID()}`,
      kind: "renewal_succeeded",
      businessId: randomUUID(),
      sourceVersion: 1,
    });
    const post = (signature?: string) =>
      postEvent(
        new Request("http://localhost/api/billing/events", {
          method: "POST",
          headers: signature ? { "x-billing-signature": signature } : {},
          body: event,
        }),
      );
    delete process.env.BILLING_WEBHOOK_SECRET;
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
    expect((await post("sha256=00")).status).toBe(503);

    const secret = "billing-test-secret-0123456789abcdef-0123456789";
    process.env.BILLING_WEBHOOK_SECRET = secret;
    expect((await post("sha256=00")).status).toBe(401);
    const signature = `sha256=${createHmac("sha256", secret).update(event).digest("hex")}`;
    const accepted = await post(signature);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ outcome: "staged" });
  });
});
