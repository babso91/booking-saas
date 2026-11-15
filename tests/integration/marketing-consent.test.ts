import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { NextRequest } from "next/server";

import { POST as oneClick } from "@/app/api/unsubscribe/[token]/route";
import {
  readUnsubscribeAction,
  resubscribeUnsubscribeAction,
  withdrawUnsubscribeAction,
} from "@/features/marketing-consent/actions";
import {
  issueUnsubscribeLink,
  type ConsentDto,
} from "@/features/marketing-consent/data";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  createBusiness,
  createClientRecord,
  createProfessional,
  db,
  env,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Marketing consent and unsubscribe links (docs/MARKETING_CONSENT_CONTRACT.md):
// the professional through PostgREST with her session; the customer through
// the page's actions and the one-click route, with nothing but the token.

const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
}) as AppSupabaseClient;

type Rpc = { data: unknown; error: { message: string } | null };
const call = (client: AppSupabaseClient, fn: string, args: object) =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);

let owner: Professional;
let stranger: Professional;
let business: TestBusiness;
let otherBusiness: TestBusiness;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  owner = await createProfessional("consent-owner");
  stranger = await createProfessional("consent-stranger");
  business = await createBusiness(owner.userId);
  otherBusiness = await createBusiness(stranger.userId);
});

const newClient = (b: TestBusiness = business, email?: string) =>
  createClientRecord(
    b.id,
    email ?? `consent-${randomUUID().slice(0, 8)}@client.test`,
    "Léa",
  );

const setConsent = (
  clientId: string,
  args: {
    channel?: string;
    action: string;
    proofVersion?: string | null;
    requestId?: string;
  },
  who: Professional = owner,
  b: TestBusiness = business,
) =>
  call(who.client, "marketing_set_consent", {
    p_business_id: b.id,
    p_client_id: clientId,
    p_purpose: "marketing",
    p_channel: args.channel ?? "email",
    p_action: args.action,
    p_proof_version: args.proofVersion ?? null,
    p_request_id: args.requestId ?? randomUUID(),
  });

const consents = async (clientId: string) => {
  const { data, error } = await call(
    owner.client,
    "marketing_client_consents",
    {
      p_business_id: business.id,
      p_client_id: clientId,
    },
  );
  if (error) throw new Error(error.message);
  return data as ConsentDto[];
};

const eventCount = async (clientId: string) =>
  (
    await db.query(
      "select count(*)::int as n from private.consent_events where client_id = $1",
      [clientId],
    )
  ).rows[0].n as number;

describe("consent, the professional's side", () => {
  it("starts unknown, needs the wording's version to grant, and replays by requestId", async () => {
    const clientId = await newClient();
    expect((await consents(clientId)).map((c) => [c.channel, c.state])).toEqual(
      [
        ["email", "unknown"],
        ["sms", "unknown"],
      ],
    );

    expect(
      (await setConsent(clientId, { action: "grant" })).error?.message,
    ).toBe("invalid_input");

    const requestId = randomUUID();
    const granted = await setConsent(clientId, {
      action: "grant",
      proofVersion: "salon-2026-11",
      requestId,
    });
    expect(granted.data).toMatchObject({
      channel: "email",
      state: "granted",
      proofVersion: "salon-2026-11",
      source: "professional",
    });
    expect(
      (
        await setConsent(clientId, {
          action: "grant",
          proofVersion: "salon-2026-11",
          requestId,
        })
      ).error,
    ).toBeNull();
    expect(await eventCount(clientId)).toBe(1);
    expect(
      (await setConsent(clientId, { action: "withdraw", requestId })).error
        ?.message,
    ).toBe("idempotency_conflict");

    const withdrawn = await setConsent(clientId, { action: "withdraw" });
    expect(withdrawn.data).toMatchObject({
      state: "withdrawn",
      proofVersion: null,
    });
    // SMS untouched.
    expect((await consents(clientId))[1]!.state).toBe("unknown");
  });

  it("is reached only by the business's members, for its own customers", async () => {
    const clientId = await newClient();
    expect(
      (
        await setConsent(
          clientId,
          { action: "grant", proofVersion: "v1" },
          stranger,
          business,
        )
      ).error?.message,
    ).toBe("forbidden");
    expect(
      (
        await setConsent(
          clientId,
          { action: "grant", proofVersion: "v1" },
          stranger,
          otherBusiness,
        )
      ).error?.message,
    ).toBe("client_not_found");
    expect(await eventCount(clientId)).toBe(0);
  });

  it("never rewrites the register", async () => {
    const clientId = await newClient();
    await setConsent(clientId, { action: "grant", proofVersion: "v1" });
    await expect(
      db.query(
        "update private.consent_events set state = 'withdrawn' where client_id = $1",
        [clientId],
      ),
    ).rejects.toThrow(/append-only/);
  });
});

describe("unsubscribe links", () => {
  it("reading changes nothing; the click withdraws once; undo brings back her grant", async () => {
    const clientId = await newClient();
    await setConsent(clientId, { action: "grant", proofVersion: "web-v2" });
    const link = await issueUnsubscribeLink(admin, {
      businessId: business.id,
      clientId,
      channel: "email",
    });
    expect(link.pageUrl).toBe(
      `http://localhost:3000/desinscription#t=${link.token}`,
    );

    const read = await readUnsubscribeAction(link.token);
    expect(read).toEqual({
      ok: true,
      data: {
        businessName: expect.any(String),
        channel: "email",
        alreadyWithdrawn: false,
        canUndo: false,
      },
    });
    expect(await eventCount(clientId)).toBe(1);

    const withdrawn = await withdrawUnsubscribeAction(link.token);
    expect(withdrawn.ok && withdrawn.data).toMatchObject({
      alreadyWithdrawn: true,
      canUndo: true,
    });
    await withdrawUnsubscribeAction(link.token);
    expect(await eventCount(clientId)).toBe(2);
    expect((await consents(clientId))[0]).toMatchObject({
      state: "withdrawn",
      source: "unsubscribe_link",
    });

    const undone = await resubscribeUnsubscribeAction(link.token);
    expect(undone.ok && undone.data).toMatchObject({
      alreadyWithdrawn: false,
      canUndo: false,
    });
    expect((await resubscribeUnsubscribeAction(link.token)).ok).toBe(true);
    expect(await eventCount(clientId)).toBe(3);
    expect((await consents(clientId))[0]).toMatchObject({
      state: "granted",
      proofVersion: "web-v2",
      source: "unsubscribe_undo",
    });
  });

  it("touches only this business and this channel", async () => {
    const email = `same-${randomUUID().slice(0, 8)}@client.test`;
    const here = await newClient(business, email);
    const there = await newClient(otherBusiness, email);
    const link = await issueUnsubscribeLink(admin, {
      businessId: business.id,
      clientId: here,
      channel: "sms",
    });
    await withdrawUnsubscribeAction(link.token);
    expect((await consents(here)).map((c) => c.state)).toEqual([
      "unknown",
      "withdrawn",
    ]);
    expect(await eventCount(there)).toBe(0);
  });

  it("answers one opaque refusal for a forged, unknown or expired link, and undo only right after", async () => {
    for (const token of ["faux", `uns_${"A".repeat(43)}`]) {
      const result = await withdrawUnsubscribeAction(token);
      expect(result.ok || result.error.code).toBe("unsubscribe_link_invalid");
    }
    const clientId = await newClient();
    const link = await issueUnsubscribeLink(admin, {
      businessId: business.id,
      clientId,
      channel: "email",
    });
    const early = await resubscribeUnsubscribeAction(link.token);
    expect(early.ok || early.error.code).toBe("unsubscribe_undo_unavailable");

    await withdrawUnsubscribeAction(link.token);
    // Her withdrawal is 31 minutes old (the register refuses updates: the
    // test steps around its trigger).
    const connection = await db.connect();
    try {
      await connection.query("set session_replication_role = replica");
      await connection.query(
        "update private.consent_events set created_at = now() - interval '31 minutes' where client_id = $1",
        [clientId],
      );
    } finally {
      await connection.query("set session_replication_role = origin");
      connection.release();
    }
    const late = await resubscribeUnsubscribeAction(link.token);
    expect(late.ok || late.error.code).toBe("unsubscribe_undo_unavailable");

    await db.query(
      "update private.unsubscribe_links set expires_at = now() - interval '1 second' where client_id = $1",
      [clientId],
    );
    const expired = await readUnsubscribeAction(link.token);
    expect(expired.ok || expired.error.code).toBe("unsubscribe_link_invalid");
  });

  it("waits for a delivery that holds the customer's lock, then withdraws", async () => {
    const clientId = await newClient();
    await setConsent(clientId, { action: "grant", proofVersion: "v1" });
    const link = await issueUnsubscribeLink(admin, {
      businessId: business.id,
      clientId,
      channel: "email",
    });
    const delivery = await db.connect();
    try {
      await delivery.query("begin");
      await delivery.query("select private.lock_consent_subject($1)", [
        clientId,
      ]);
      let settled = false;
      const withdrawing = withdrawUnsubscribeAction(link.token).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      // The delivery's last check, under the lock, still reads her grant.
      const { rows } = await delivery.query(
        "select private.consent_state($1, 'marketing', 'email') as state",
        [clientId],
      );
      expect(rows[0].state).toBe("granted");
      await delivery.query("commit");
      expect((await withdrawing).ok).toBe(true);
    } finally {
      delivery.release();
    }
    expect((await consents(clientId))[0]!.state).toBe("withdrawn");
  });

  it("unsubscribes in one click from the mail client, never on a plain visit", async () => {
    const clientId = await newClient();
    const link = await issueUnsubscribeLink(admin, {
      businessId: business.id,
      clientId,
      channel: "email",
    });
    const response = await oneClick(
      new NextRequest(link.oneClickUrl, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
      { params: Promise.resolve({ token: link.token }) },
    );
    expect(response.status).toBe(200);
    expect((await consents(clientId))[0]!.state).toBe("withdrawn");

    const forged = await oneClick(
      new NextRequest("http://localhost:3000/api/unsubscribe/x", {
        method: "POST",
      }),
      { params: Promise.resolve({ token: "x" }) },
    );
    expect(forged.status).toBe(404);
  });
});
