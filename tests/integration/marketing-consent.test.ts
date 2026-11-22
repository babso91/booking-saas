import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { POST as oneClick } from "@/app/api/unsubscribe/[token]/route";
import {
  readUnsubscribeAction,
  resubscribeUnsubscribeAction,
  withdrawUnsubscribeAction,
} from "@/features/marketing-consent/actions";
import {
  hashUnsubscribeToken,
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

vi.mock("@/features/notifications/data/kick", () => ({
  kickEmailOutbox: () => undefined,
}));
vi.mock("@/features/calendar/data/outbound-kick", () => ({
  kickCalendarOutbound: () => undefined,
}));

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

async function ok<T>(promise: Promise<Rpc>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

const collection = (enabled: boolean) =>
  ok(
    call(admin, "platform_set_flag", {
      p_key: "marketing_consent_collection",
      p_enabled: enabled,
      p_note: "tests",
    }),
  );

afterAll(() => collection(false));

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  owner = await createProfessional("consent-owner");
  stranger = await createProfessional("consent-stranger");
  business = await createBusiness(owner.userId);
  otherBusiness = await createBusiness(stranger.userId);
  // As the administrator does (docs/MARKETING_CONSENT_OPERATIONS.md): a
  // notice registered, the V1 texts activated, collection switched on for
  // these tests only.
  await ok(
    call(admin, "consent_text_register", {
      p_version: "notice-test",
      p_kind: "notice",
      p_body: "Notice de test (données synthétiques).",
    }),
  );
  for (const version of [
    "email-v1",
    "sms-v1",
    "information-v1",
    "notice-test",
  ]) {
    const { rows } = await db.query(
      "select body_sha256, state from private.consent_texts where version = $1",
      [version],
    );
    if (rows[0].state === "draft") {
      await ok(
        call(admin, "consent_text_activate", {
          p_version: version,
          p_expected_sha256: rows[0].body_sha256,
          p_note: "test",
        }),
      );
    }
  }
  await collection(true);
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

/** Her boxes ticked with a booking of hers: pending, with its token. */
async function requested(
  clientId: string,
  channels: Record<string, string> = { email: "email-v1" },
  b: TestBusiness = business,
) {
  const appointmentId = await bookingOf(clientId, b);
  const token = `cnf_${randomUUID().replace(/-/g, "")}${"x".repeat(11)}`;
  const answer = await ok<{ status: string }>(
    call(admin, "consent_request_from_booking", {
      p_appointment_id: appointmentId,
      p_channels: channels,
      p_information_version: "information-v1",
      p_notice_version: "notice-test",
      p_token_hash: hashUnsubscribeToken(token),
    }),
  );
  return { answer, token, appointmentId };
}

/** Her own agreement: ticked with her booking, then confirmed from her mailbox. */
async function granted(
  clientId: string,
  channel = "email",
  b: TestBusiness = business,
) {
  const { token } = await requested(
    clientId,
    { [channel]: `${channel}-v1` },
    b,
  );
  return ok<{ status: string; channels: Record<string, string> }>(
    call(admin, "consent_confirm", {
      p_token_hash: hashUnsubscribeToken(token),
    }),
  );
}

let slot = 0;
async function bookingOf(clientId: string, b: TestBusiness = business) {
  slot += 1;
  const service = (
    await db.query(
      `insert into public.services (business_id, name, duration_minutes, price_cents)
       values ($1, 'Pose', 60, 5000) returning id`,
      [b.id],
    )
  ).rows[0].id as string;
  const start = new Date(Date.now() + (5 + slot) * 86_400_000);
  start.setUTCHours(9, 0, 0, 0);
  const { rows } = await db.query(
    `insert into public.appointments (business_id, client_id, service_id, starts_at, ends_at,
       service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot)
     values ($1, $2, $3, $4, $5, 'Pose', 60, 5000) returning id`,
    [
      b.id,
      clientId,
      service,
      start.toISOString(),
      new Date(start.getTime() + 3_600_000).toISOString(),
    ],
  );
  return rows[0].id as string;
}

describe("consent, the professional's side", () => {
  it("starts unknown; she may record a withdrawal, never an agreement", async () => {
    const clientId = await newClient();
    expect((await consents(clientId)).map((c) => [c.channel, c.state])).toEqual(
      [
        ["email", "unknown"],
        ["sms", "unknown"],
      ],
    );
    expect(
      (
        await setConsent(clientId, {
          action: "grant",
          proofVersion: "email-v1",
        })
      ).error?.message,
    ).toBe("consent_direct_only");
    expect(await eventCount(clientId)).toBe(0);

    const requestId = randomUUID();
    const withdrawn = await setConsent(clientId, {
      action: "withdraw",
      requestId,
    });
    expect(withdrawn.data).toMatchObject({
      state: "withdrawn",
      source: "professional",
    });
    expect(
      (await setConsent(clientId, { action: "withdraw", requestId })).error,
    ).toBeNull();
    expect(await eventCount(clientId)).toBe(1);
  });

  it("is reached only by the business's members, for its own customers", async () => {
    const clientId = await newClient();
    expect(
      (await setConsent(clientId, { action: "withdraw" }, stranger, business))
        .error?.message,
    ).toBe("forbidden");
    expect(
      (
        await setConsent(
          clientId,
          { action: "withdraw" },
          stranger,
          otherBusiness,
        )
      ).error?.message,
    ).toBe("client_not_found");
    expect(await eventCount(clientId)).toBe(0);
  });

  it("never rewrites the register", async () => {
    const clientId = await newClient();
    await granted(clientId);
    await expect(
      db.query(
        "update private.consent_events set state = 'withdrawn' where client_id = $1",
        [clientId],
      ),
    ).rejects.toThrow(/append-only/);
  });
});

describe("her own agreement, with her booking", () => {
  it("waits for her confirmation from her mailbox, then keeps its full proof", async () => {
    const clientId = await newClient();
    const { answer, token } = await requested(clientId);
    expect(answer).toMatchObject({ status: "pending" });
    // Ticked, not confirmed: nothing recorded.
    expect(await eventCount(clientId)).toBe(0);

    const confirmed = await ok<{
      status: string;
      channels: Record<string, string>;
    }>(
      call(admin, "consent_confirm", {
        p_token_hash: hashUnsubscribeToken(token),
      }),
    );
    expect(confirmed).toMatchObject({
      status: "confirmed",
      channels: { email: "granted" },
    });
    expect(
      await ok(
        call(admin, "consent_confirm", {
          p_token_hash: hashUnsubscribeToken(token),
        }),
      ),
    ).toMatchObject({ status: "already_confirmed" });

    const { rows } = await db.query(
      `select e.business_id, e.channel, e.source, e.evidence, e.proof_version,
              e.information_version, e.notice_version, t.body
       from private.consent_events e join private.consent_texts t on t.version = e.proof_version
       where e.client_id = $1`,
      [clientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      business_id: business.id,
      channel: "email",
      source: "booking",
      proof_version: "email-v1",
      information_version: "information-v1",
      notice_version: "notice-test",
      body: "J'accepte de recevoir par e-mail les offres, promotions et nouveautés commerciales de cet établissement.",
    });
    expect(rows[0].evidence).toMatchObject({
      appointmentId: expect.any(String),
      confirmationId: expect.any(String),
      confirmedBy: "email_link",
    });

    const history = await ok<
      { state: string; source: string; informationVersion: string }[]
    >(
      call(owner.client, "marketing_client_consent_history", {
        p_business_id: business.id,
        p_client_id: clientId,
      }),
    );
    expect(history).toEqual([
      expect.objectContaining({
        state: "granted",
        source: "booking",
        informationVersion: "information-v1",
      }),
    ]);
    await setConsent(clientId, { action: "withdraw" });
    expect((await consents(clientId))[0]!.state).toBe("withdrawn");
  });

  it("someone booking with her address cannot agree for her: without her click, her withdrawal stands", async () => {
    const clientId = await newClient();
    await setConsent(clientId, { action: "withdraw" });
    // A third party books with her email and ticks the box.
    const { answer } = await requested(clientId);
    expect(answer.status).toBe("pending");
    expect((await consents(clientId))[0]!.state).toBe("withdrawn");
    // An unknown or forged link: one answer.
    expect(
      (
        await call(admin, "consent_confirm", {
          p_token_hash: hashUnsubscribeToken("cnf_faux"),
        })
      ).error?.message,
    ).toBe("consent_link_invalid");
  });

  it("an SMS agreement is only for the number typed with that booking, if it is hers", async () => {
    const clientId = await newClient();
    await db.query(
      "update public.clients set phone = '+33600000001' where id = $1",
      [clientId],
    );
    const { token, appointmentId } = await requested(clientId, {
      sms: "sms-v1",
    });
    // The booking was made with another number.
    await db.query(
      "update private.consent_confirmations set phone = '+33600000002' where appointment_id = $1",
      [appointmentId],
    );
    expect(
      await ok(
        call(admin, "consent_confirm", {
          p_token_hash: hashUnsubscribeToken(token),
        }),
      ),
    ).toMatchObject({ channels: { sms: "unreachable" } });
    expect(await eventCount(clientId)).toBe(0);
  });

  it("an agreement is for the address it was confirmed from, never moved to a new one", async () => {
    const clientId = await newClient(
      business,
      `avant-${randomUUID().slice(0, 6)}@client.test`,
    );
    const state = async () =>
      (
        await db.query(
          "select private.consent_state($1, 'marketing', 'email') as s",
          [clientId],
        )
      ).rows[0].s as string;

    // The address changes between her request and the click: nothing counts.
    const { token } = await requested(clientId);
    await db.query("update public.clients set email = $2 where id = $1", [
      clientId,
      `apres-${randomUUID().slice(0, 6)}@client.test`,
    ]);
    expect(
      await ok(
        call(admin, "consent_confirm", {
          p_token_hash: hashUnsubscribeToken(token),
        }),
      ),
    ).toMatchObject({ channels: { email: "unreachable" } });
    expect(await eventCount(clientId)).toBe(0);
    expect(await state()).toBe("unknown");

    // Confirmed for this address, then the record's changes: no longer valid.
    await granted(clientId);
    expect(await state()).toBe("granted");
    await db.query("update public.clients set email = $2 where id = $1", [
      clientId,
      `nouvelle-${randomUUID().slice(0, 6)}@client.test`,
    ]);
    expect(await state()).toBe("unknown");
    expect(
      (await consents(clientId)).find((c) => c.channel === "email"),
    ).toMatchObject({
      state: "unknown",
      destinationChanged: true,
    });
  });

  it("a link that never left can be sent again for the same booking, only until one leaves", async () => {
    const clientId = await newClient();
    const appointmentId = await bookingOf(clientId);
    const ask = (token: string) =>
      ok<{ status: string }>(
        call(admin, "consent_request_from_booking", {
          p_appointment_id: appointmentId,
          p_channels: { email: "email-v1" },
          p_information_version: "information-v1",
          p_notice_version: "notice-test",
          p_token_hash: hashUnsubscribeToken(token),
        }),
      );
    // Unique per run: a token hash is unique across the database.
    const token = () => `cnf_${randomBytes(32).toString("base64url")}`;
    const first = token();
    const second = token();
    expect(await ask(first)).toMatchObject({ status: "pending" });
    // The transport failed (never marked sent): the retry gets a new link.
    expect(await ask(second)).toMatchObject({ status: "pending" });
    expect(
      (
        await call(admin, "consent_confirm", {
          p_token_hash: hashUnsubscribeToken(first),
        })
      ).error?.message,
    ).toBe("consent_link_invalid");
    await ok(
      call(admin, "consent_confirmation_sent", {
        p_token_hash: hashUnsubscribeToken(second),
      }),
    );
    expect(await ask(token())).toMatchObject({
      status: "already_requested",
    });
    expect(
      await ok(
        call(admin, "consent_confirm", {
          p_token_hash: hashUnsubscribeToken(second),
        }),
      ),
    ).toMatchObject({ status: "confirmed" });
  });

  it("asks nothing while collection is off or with a text not active", async () => {
    const clientId = await newClient();
    await collection(false);
    try {
      expect((await requested(clientId)).answer.status).toBe("collection_off");
    } finally {
      await collection(true);
    }
    expect(
      (await requested(clientId, { email: "brouillon" })).answer.status,
    ).toBe("text_not_active");
  });

  it("the booking route sends the confirmation and never depends on the boxes", async () => {
    const { POST: book } = await import("@/app/api/bookings/route");
    process.env.BOOKING_PROXY_SECRET =
      "consent-test-proxy-secret-0123456789abcdef";
    process.env.EMAIL_TRANSPORT = "mailpit";
    process.env.EMAIL_FROM = "Booking <noreply@test.local>";
    const mailpit = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
    const { setWeeklyHours, everyDay, createService, dateInDays, randomIp } =
      await import("./support/fixtures");
    await setWeeklyHours(business.id, everyDay(["08:00", "20:00"]));
    const serviceId = await createService(business.id, { name: "Coupe" });
    const send = (email: string, marketingConsent?: object, hour = 10) =>
      book(
        new NextRequest("http://localhost:3000/api/bookings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-booking-proxy-secret":
              "consent-test-proxy-secret-0123456789abcdef",
            "x-booking-client-ip": randomIp(),
          },
          body: JSON.stringify({
            slug: business.slug,
            serviceId,
            startsAt: `${dateInDays(4)}T${String(hour).padStart(2, "0")}:00:00.000Z`,
            firstName: "Nina",
            email,
            requestId: randomUUID(),
            ...(marketingConsent ? { marketingConsent } : {}),
          }),
        }),
      );
    const versions = {
      email: "email-v1",
      sms: "sms-v1",
      information: "information-v1",
      notice: "notice-test",
    };

    const yes = `oui-${randomUUID().slice(0, 6)}@client.test`;
    const ticked = await send(yes, { email: true, sms: false, versions });
    expect(ticked.status).toBe(201);
    expect((await ticked.json()).data.marketingConsent).toEqual({
      status: "pending",
    });
    // Her mailbox gets the link; her click records the agreement.
    let token: string | undefined;
    for (let attempt = 0; attempt < 40 && !token; attempt += 1) {
      const list = await (
        await fetch(
          `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${yes}"`)}`,
        )
      ).json();
      const found = (list.messages ?? [])[0];
      if (found) {
        const message = await (
          await fetch(`${mailpit}/api/v1/message/${found.ID}`)
        ).json();
        token = (message.Text as string).match(
          /#t=(cnf_[A-Za-z0-9_-]{43})/,
        )?.[1];
      }
      if (!token) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(token).toBeDefined();
    const { confirmConsentAction } =
      await import("@/features/marketing-consent/actions");
    expect(await confirmConsentAction(token)).toMatchObject({
      ok: true,
      data: { status: "confirmed", channels: { email: "granted" } },
    });

    // No box: booked all the same, nothing asked.
    const plain = await send(
      `non-${randomUUID().slice(0, 6)}@client.test`,
      undefined,
      11,
    );
    expect(plain.status).toBe(201);
    expect((await plain.json()).data.marketingConsent).toBeUndefined();

    // No email transport: booked all the same, nothing waits.
    delete process.env.EMAIL_TRANSPORT;
    const noMail = await send(
      `nomail-${randomUUID().slice(0, 6)}@client.test`,
      { email: true, versions },
      12,
    );
    expect(noMail.status).toBe(201);
    expect((await noMail.json()).data.marketingConsent).toEqual({
      status: "email_unavailable",
    });
  });
});

describe("texts", () => {
  it("are archived in full, never rewritten, and activated only as checked", async () => {
    await expect(
      db.query(
        "update private.consent_texts set body = 'autre' where version = 'email-v1'",
      ),
    ).rejects.toThrow(/consent_text_immutable/);
    const version = `notice-${randomUUID().slice(0, 6)}`;
    const draft = await ok<{ sha256: string; state: string }>(
      call(admin, "consent_text_register", {
        p_version: version,
        p_kind: "notice",
        p_body: "Notice A",
      }),
    );
    expect(draft.state).toBe("draft");
    expect(
      (
        await call(admin, "consent_text_register", {
          p_version: version,
          p_kind: "notice",
          p_body: "Notice B",
        })
      ).error?.message,
    ).toBe("consent_text_conflict");
    expect(
      (
        await call(admin, "consent_text_activate", {
          p_version: version,
          p_expected_sha256: "0".repeat(64),
          p_note: null,
        })
      ).error?.message,
    ).toBe("consent_text_changed");
    // Only the administrator (the service): never a professional.
    expect(
      (
        await call(owner.client, "consent_text_activate", {
          p_version: version,
          p_expected_sha256: draft.sha256,
          p_note: null,
        })
      ).error,
    ).not.toBeNull();
    const current = await ok<{
      collectionEnabled: boolean;
      texts: Record<string, { version: string }>;
    }>(call(admin, "consent_texts_current", {}));
    expect(current.collectionEnabled).toBe(true);
    expect(current.texts.email!.version).toBe("email-v1");
  });

  it("the notice names the business and lists what it still needs, never invented", async () => {
    const notice = await ok<{ businessName: string; missing: string[] }>(
      call(admin, "consent_notice", { p_slug: business.slug }),
    );
    expect(notice.missing).toEqual([
      "controller.address",
      "controller.contactEmail",
      "controller.legalName",
    ]);
    await ok(
      call(owner.client, "set_business_legal_profile", {
        p_business_id: business.id,
        p_legal_name: "Studio Test SAS",
        p_address: "1 rue de l'Exemple, 75000 Paris",
        p_contact_email: "contact@studio.test",
        p_registration_number: null,
      }),
    );
    expect(
      (
        await ok<{ missing: string[] }>(
          call(admin, "consent_notice", { p_slug: business.slug }),
        )
      ).missing,
    ).toEqual([]);
  });
});

describe("unsubscribe links", () => {
  it("reading changes nothing; the click withdraws once; undo brings back her grant", async () => {
    const clientId = await newClient();
    await granted(clientId);
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
      proofVersion: "email-v1",
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
    await granted(clientId);
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
