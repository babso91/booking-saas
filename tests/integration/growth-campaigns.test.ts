import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SimulatedMarketingTransport,
  type MarketingMessage,
  type SendOutcome,
} from "@/features/growth-server/transport";
import { runGrowthQueue } from "@/features/growth-server/worker";
import { hashUnsubscribeToken } from "@/features/marketing-consent/data";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  db,
  env,
  insertAppointment,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Campaigns (docs/GROWTH_CAMPAIGNS_CONTRACT.md): the owner through
// PostgREST with her session, the worker with the service and a simulated
// transport. Recipe of R4-01: C1 future appointment, C2 consenting and
// inactive, C3 withdrawn, C4 last visit missed; only C2 is reached.

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

type Estimate = {
  estimateId: string;
  matched: number;
  eligible: number;
  suppressedByReason: Record<string, number>;
  estimatedUnits: number;
  simulated: boolean;
};
type Campaign = {
  campaignId: string;
  version: number;
  state: string;
  unitsUsed: number;
  counts: Record<string, number>;
  suppressedByReason: Record<string, number>;
};

let owner: Professional;
let stranger: Professional;
let business: TestBusiness;
let serviceId: string;
let slot = 0;

const DAY = 86_400_000;
/** A distinct hour `days` from now (negative: past). */
function at(days: number) {
  slot += 1;
  const start = new Date(Date.now() + days * DAY + slot * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}

async function customer(options: {
  completedDaysAgo?: number;
  then?: "no_show" | "future";
  consent?: "granted" | "withdrawn";
}) {
  const clientId = await createClientRecord(
    business.id,
    `growth-${randomUUID().slice(0, 8)}@client.test`,
    "Cliente",
  );
  if (options.completedDaysAgo) {
    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId,
      status: "completed",
      ...at(-options.completedDaysAgo),
    });
  }
  if (options.then === "no_show") {
    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId,
      status: "no_show",
      ...at(-options.completedDaysAgo! + 10),
    });
  }
  if (options.then === "future") {
    await insertAppointment({
      businessId: business.id,
      clientId,
      serviceId,
      ...at(20),
    });
  }
  if (options.consent === "granted") {
    // An agreement she confirmed from her mailbox (the consent register's
    // own tests cover how one is given): arranged directly.
    await db.query(
      `insert into private.consent_events (business_id, client_id, purpose, channel, state,
         proof_version, information_version, notice_version, source, evidence, destination)
       values ($1, $2, 'marketing', 'email', 'granted', 'email-v1', 'information-v1',
         'notice-growth-test', 'booking', '{"confirmedBy": "email_link"}',
         private.consent_destination($2, 'email'))`,
      [business.id, clientId],
    );
  } else if (options.consent === "withdrawn") {
    await ok(
      call(owner.client, "marketing_set_consent", {
        p_business_id: business.id,
        p_client_id: clientId,
        p_purpose: "marketing",
        p_channel: "email",
        p_action: "withdraw",
        p_proof_version: null,
        p_request_id: randomUUID(),
      }),
    );
  }
  return clientId;
}

/**
 * A fresh business with its own audience, so each test counts alone. The
 * queue is global: campaigns left open by earlier tests are closed first.
 */
async function freshBusiness() {
  await db.query(
    "update private.growth_campaigns set state = 'cancelled' where state in ('scheduled', 'running', 'paused')",
  );
  business = await createBusiness(owner.userId);
  serviceId = await createService(business.id, { name: "Pose" });
}

const estimate = (
  inactiveDays = 60,
  message = "Envie d’un nouveau rendez-vous ?",
  who = owner,
) =>
  call(who.client, "growth_estimate", {
    p_business_id: business.id,
    p_criteria: { kind: "reactivation", inactiveDays },
    p_channel: "email",
    p_message: message,
  });

const schedule = (
  estimateId: string,
  maxUnits = 50,
  requestId = randomUUID(),
) =>
  call(owner.client, "growth_schedule", {
    p_business_id: business.id,
    p_estimate_id: estimateId,
    p_max_units: maxUnits,
    p_request_id: requestId,
  });

const read = (campaignId: string) =>
  ok<Campaign>(
    call(owner.client, "growth_read", {
      p_business_id: business.id,
      p_campaign_id: campaignId,
    }),
  );

async function planned(maxUnits = 50) {
  const e = await ok<Estimate>(estimate());
  return ok<Campaign>(schedule(e.estimateId, maxUnits));
}

const run = (
  transport = new SimulatedMarketingTransport({ keepMessages: true }),
) =>
  runGrowthQueue({
    service,
    transport,
    appUrl: "http://localhost:3000",
    limit: 200,
  }).then((result) => ({ result, transport }));

beforeAll(async () => {
  // A notice text for the arranged agreements (a draft is enough here).
  await db.query(
    `insert into private.consent_texts (version, kind, body)
     values ('notice-growth-test', 'notice', 'Notice de test') on conflict do nothing`,
  );
  owner = await createProfessional("growth-owner");
  stranger = await createProfessional("growth-stranger");
  await createBusiness(stranger.userId);
});

describe("estimate and schedule", () => {
  it("counts by reason, never names, and reaches only the consenting inactive customer", async () => {
    await freshBusiness();
    await customer({
      completedDaysAgo: 100,
      then: "future",
      consent: "granted",
    });
    await customer({ completedDaysAgo: 100, consent: "granted" });
    await customer({ completedDaysAgo: 100, consent: "withdrawn" });
    await customer({
      completedDaysAgo: 100,
      then: "no_show",
      consent: "granted",
    });
    await customer({ completedDaysAgo: 10, consent: "granted" }); // not inactive

    const e = await ok<Estimate>(estimate());
    expect(e).toMatchObject({
      matched: 4,
      eligible: 1,
      suppressedByReason: {
        future_appointment: 1,
        no_consent: 1,
        last_visit_not_completed: 1,
      },
      estimatedUnits: 1,
      simulated: true,
    });
    expect(JSON.stringify(e)).not.toContain("@client.test");

    expect((await estimate(60, "x", stranger)).error?.message).toBe(
      "forbidden",
    );
    expect(
      (
        await call(owner.client, "growth_estimate", {
          p_business_id: business.id,
          p_criteria: { kind: "notes", contains: "allergie" },
          p_channel: "email",
          p_message: "x",
        })
      ).error?.message,
    ).toBe("invalid_input");
  });

  it("never writes to an address she did not agree for: a changed email needs a new agreement", async () => {
    await freshBusiness();
    const moved = await customer({ completedDaysAgo: 100, consent: "granted" });
    expect(await ok<Estimate>(estimate())).toMatchObject({ eligible: 1 });
    await db.query("update public.clients set email = $2 where id = $1", [
      moved,
      `nouvelle-${randomUUID().slice(0, 6)}@client.test`,
    ]);
    expect(await ok<Estimate>(estimate())).toMatchObject({
      eligible: 0,
      suppressedByReason: { no_consent: 1 },
    });
  });

  it("refuses a stale or reused estimate and a cap over the month's budget; replays by requestId", async () => {
    await freshBusiness();
    await customer({ completedDaysAgo: 100, consent: "granted" });

    const e1 = await ok<Estimate>(estimate());
    expect((await schedule(e1.estimateId, 2001)).error?.message).toBe(
      "quota_exceeded",
    );
    const requestId = randomUUID();
    const first = await ok<Campaign>(schedule(e1.estimateId, 5, requestId));
    expect(await ok(schedule(e1.estimateId, 5, requestId))).toEqual(first);
    expect((await schedule(e1.estimateId, 6, requestId)).error?.message).toBe(
      "idempotency_conflict",
    );
    expect((await schedule(e1.estimateId, 5)).error?.message).toBe(
      "estimate_stale",
    );

    const e2 = await ok<Estimate>(estimate());
    await db.query(
      "update private.growth_estimates set expires_at = now() - interval '1 second' where id = $1",
      [e2.estimateId],
    );
    expect((await schedule(e2.estimateId)).error?.message).toBe(
      "estimate_stale",
    );
    // Its campaign never runs here: later runs must not pick it up.
    await db.query(
      "update private.growth_campaigns set state = 'cancelled' where business_id = $1",
      [business.id],
    );
  });
});

describe("delivery", () => {
  it("sends once with a one-click unsubscribe, completes, and gives the unused cap back", async () => {
    await freshBusiness();
    const clientId = await customer({
      completedDaysAgo: 100,
      consent: "granted",
    });
    const campaign = await planned(10);

    const { result, transport } = await run();
    expect(result).toMatchObject({ sent: 1 });
    const [message] = transport.messages;
    expect(message!.recipient).toMatch(/@client\.test$/);
    const header = message!.rendered.headers!["List-Unsubscribe"]!;
    const token = header.match(/uns_[A-Za-z0-9_-]{43}/)![0];

    const done = await read(campaign.campaignId);
    expect(done).toMatchObject({ state: "completed", unitsUsed: 1 });
    expect(done.counts.accepted).toBe(1);
    const { rows } = await db.query(
      "select units_committed from private.growth_budgets where business_id = $1",
      [business.id],
    );
    expect(rows[0].units_committed).toBe(1);

    // Her link works; the next campaign sees her as contacted recently.
    const withdrawn = await service.rpc("unsubscribe_withdraw", {
      p_token_hash: hashUnsubscribeToken(token),
    });
    expect(withdrawn.error).toBeNull();
    const again = await ok<Estimate>(estimate());
    expect(again.suppressedByReason).toEqual({ no_consent: 1 });
    void clientId;
  });

  it("re-checks just before sending: a withdrawal or a new booking since scheduling stops it", async () => {
    await freshBusiness();
    const withdrawing = await customer({
      completedDaysAgo: 100,
      consent: "granted",
    });
    const booking = await customer({
      completedDaysAgo: 100,
      consent: "granted",
    });
    const campaign = await planned();
    expect((await read(campaign.campaignId)).counts.pending).toBe(2);

    await ok(
      call(owner.client, "marketing_set_consent", {
        p_business_id: business.id,
        p_client_id: withdrawing,
        p_purpose: "marketing",
        p_channel: "email",
        p_action: "withdraw",
        p_proof_version: null,
        p_request_id: randomUUID(),
      }),
    );
    await insertAppointment({
      businessId: business.id,
      clientId: booking,
      serviceId,
      ...at(5),
    });

    const { result, transport } = await run();
    expect(result.sent).toBe(0);
    expect(transport.accepted.size).toBe(0);
    expect((await read(campaign.campaignId)).suppressedByReason).toEqual({
      no_consent: 1,
      future_appointment: 1,
    });
  });

  it("two workers racing for the last unit: exactly one message leaves", async () => {
    await freshBusiness();
    await customer({ completedDaysAgo: 100, consent: "granted" });
    await customer({ completedDaysAgo: 100, consent: "granted" });
    const campaign = await planned(1);

    const transport = new SimulatedMarketingTransport();
    const deps = {
      service,
      transport,
      appUrl: "http://localhost:3000",
      limit: 1,
    };
    await Promise.all([runGrowthQueue(deps), runGrowthQueue(deps)]);
    await runGrowthQueue(deps);

    expect(transport.accepted.size).toBe(1);
    const after = await read(campaign.campaignId);
    expect(after.unitsUsed).toBe(1);
    expect(after.suppressedByReason).toEqual({ budget_exhausted: 1 });
  });

  it("a worker whose lease ran out cannot authorize nor report", async () => {
    await freshBusiness();
    await customer({ completedDaysAgo: 100, consent: "granted" });
    await planned();

    const [claimA] = await ok<{ occurrence_id: string; fence: number }[]>(
      call(service, "growth_claim", { p_limit: 1, p_lease_seconds: 30 }),
    );
    await db.query(
      "update private.growth_occurrences set lease_until = now() - interval '1 second' where id = $1",
      [claimA!.occurrence_id],
    );
    const [claimB] = await ok<{ occurrence_id: string; fence: number }[]>(
      call(service, "growth_claim", { p_limit: 1, p_lease_seconds: 30 }),
    );
    expect(claimB!.occurrence_id).toBe(claimA!.occurrence_id);
    expect(claimB!.fence).toBe(claimA!.fence + 1);

    const hash = hashUnsubscribeToken(`uns_${randomUUID()}`);
    expect(
      await ok(
        call(service, "growth_authorize", {
          p_occurrence_id: claimA!.occurrence_id,
          p_fence: claimA!.fence,
          p_unsubscribe_token_hash: hash,
        }),
      ),
    ).toEqual({ outcome: "stale" });
    expect(
      await ok(
        call(service, "growth_authorize", {
          p_occurrence_id: claimB!.occurrence_id,
          p_fence: claimB!.fence,
          p_unsubscribe_token_hash: hash,
        }),
      ),
    ).toMatchObject({ outcome: "send" });
    expect(
      await ok(
        call(service, "growth_report", {
          p_occurrence_id: claimA!.occurrence_id,
          p_fence: claimA!.fence,
          p_outcome: "accepted",
        }),
      ),
    ).toBe("stale");
  });

  it("an answer lost after acceptance stays uncertain and is reconciled, never sent twice", async () => {
    await freshBusiness();
    await customer({ completedDaysAgo: 100, consent: "granted" });
    const campaign = await planned();

    class LosingTransport extends SimulatedMarketingTransport {
      sends = 0;
      override async send(message: MarketingMessage): Promise<SendOutcome> {
        this.sends += 1;
        await super.send(message);
        throw new Error("timeout");
      }
    }
    const transport = new LosingTransport();
    // The same run reconciles it: the lookup finds the key, nothing is resent.
    const { result } = await run(transport);
    expect(result.uncertain).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(transport.sends).toBe(1);
    expect(await read(campaign.campaignId)).toMatchObject({
      state: "completed",
      unitsUsed: 1,
    });
  });
});

describe("recovery", () => {
  it("a handoff whose report never came is reconciled after 5 minutes, then sent once", async () => {
    await freshBusiness();
    await customer({ completedDaysAgo: 100, consent: "granted" });
    const campaign = await planned();

    // The worker handed it off, then stopped before sending and reporting.
    const [claim] = await ok<{ occurrence_id: string; fence: number }[]>(
      call(service, "growth_claim", { p_limit: 1, p_lease_seconds: 30 }),
    );
    await ok(
      call(service, "growth_authorize", {
        p_occurrence_id: claim!.occurrence_id,
        p_fence: claim!.fence,
        p_unsubscribe_token_hash: hashUnsubscribeToken(`uns_${randomUUID()}`),
      }),
    );
    expect((await read(campaign.campaignId)).counts.handedOff).toBe(1);

    // Under 5 minutes: left alone (it may still be on its way).
    expect((await run()).result.reconciled).toBe(0);
    await db.query(
      "update private.growth_occurrences set handed_off_at = now() - interval '6 minutes' where id = $1",
      [claim!.occurrence_id],
    );
    // The provider never saw it: planned again, then sent once.
    const first = await run();
    expect(first.result.reconciled).toBe(1);
    const second = await run(first.transport);
    expect(second.result.sent).toBe(1);
    expect(first.transport.accepted.size).toBe(1);
    expect(await read(campaign.campaignId)).toMatchObject({
      state: "completed",
      unitsUsed: 1,
    });
  });

  it("counts SMS units as the network does, and refuses more than four parts", async () => {
    const units = async (message: string) =>
      (await db.query("select private.growth_units('sms', $1) as n", [message]))
        .rows[0].n as number;
    expect(await units("a".repeat(160))).toBe(1);
    expect(await units("a".repeat(159) + "€")).toBe(2); // € takes two septets
    expect(await units("é".repeat(160))).toBe(1); // é is in the GSM alphabet
    expect(await units("ś".repeat(70))).toBe(1);
    expect(await units("😀".repeat(35))).toBe(1); // two code units each
    expect(await units("😀".repeat(36))).toBe(2);

    await freshBusiness();
    const refused = await call(owner.client, "growth_estimate", {
      p_business_id: business.id,
      p_criteria: { kind: "reactivation", inactiveDays: 60 },
      p_channel: "sms",
      p_message: "ś".repeat(300),
    });
    expect(refused.error?.message).toBe("invalid_input");
  });
});

describe("pause, resume, cancel", () => {
  it("a paused campaign waits, resumes, and a cancelled one never sends and frees its cap", async () => {
    await freshBusiness();
    await customer({ completedDaysAgo: 100, consent: "granted" });
    const campaign = await planned(20);
    const setState = (action: string, expectedVersion: number) =>
      call(owner.client, "growth_set_state", {
        p_business_id: business.id,
        p_campaign_id: campaign.campaignId,
        p_expected_version: expectedVersion,
        p_request_id: randomUUID(),
        p_action: action,
      });

    const paused = await ok<Campaign>(setState("pause", campaign.version));
    expect(paused.state).toBe("paused");
    expect((await setState("resume", campaign.version)).error?.message).toBe(
      "version_conflict",
    );
    expect((await run()).result.sent).toBe(0);
    expect((await read(campaign.campaignId)).counts.pending).toBe(1);

    const cancelled = await ok<Campaign>(setState("cancel", paused.version));
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.counts.pending).toBe(0);
    expect((await run()).result.sent).toBe(0);
    expect((await setState("resume", cancelled.version)).error?.message).toBe(
      "campaign_closed",
    );
    const { rows } = await db.query(
      "select units_committed from private.growth_budgets where business_id = $1",
      [business.id],
    );
    expect(rows[0].units_committed).toBe(0);
  });
});
