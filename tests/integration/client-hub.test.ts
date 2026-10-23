import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getClientHubAccessAction,
  setClientHubAccessAction,
} from "@/features/client-hub/actions/access";
import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { MemoryTransport } from "@/features/notifications/transport/memory";
import type { ConfiguredTransport } from "@/features/notifications/transport";
import type { ActionResult } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import { POST as postCode } from "@/app/api/client-hub/session/code/route";
import { POST as postVerify } from "@/app/api/client-hub/session/verify/route";
import { DELETE as deleteSession } from "@/app/api/client-hub/session/route";
import { GET as getMe } from "@/app/api/client-hub/me/route";
import { GET as getAppointments } from "@/app/api/client-hub/businesses/[businessId]/appointments/route";
import { GET as getAppointment } from "@/app/api/client-hub/businesses/[businessId]/appointments/[appointmentId]/route";
import { GET as getLoyalty } from "@/app/api/client-hub/businesses/[businessId]/loyalty/route";
import { GET as getLedger } from "@/app/api/client-hub/businesses/[businessId]/loyalty/ledger/route";
import { CookieJar } from "../support/cookie-jar";
import { NextRequest } from "next/server";

import {
  anonClient,
  bookingClient,
  bookingRequest,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  env,
  everyDay,
  insertAppointment,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  waitUntilBlocked,
} from "./support/transactions";

// Client Hub V1 against the real stack: the route handlers are called as a
// browser would (cookie, trusted-ingress headers), the email transport is
// the in-memory one, and every authorization is attempted from the wrong
// side too (other customer, other business, forged identifiers, other
// roles).

let sessionClient: AppSupabaseClient;
let transport: MemoryTransport;
let configured: ConfiguredTransport | null;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/features/notifications/transport", () => ({
  getEmailTransport: () => configured,
}));

const SECRET = "client-hub-test-proxy-secret-0123456789abcdef";
const BASE = "http://localhost:3000";

beforeAll(() => {
  process.env.BOOKING_PROXY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
});

beforeEach(() => {
  transport = new MemoryTransport();
  configured = { transport, from: "Booking <noreply@test.local>" };
});

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

type Call = {
  body?: unknown;
  cookie?: string | null;
  ip?: string;
  proxySecret?: string | null;
};

function request(method: string, path: string, call: Call = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (call.proxySecret !== null) {
    headers.set("x-booking-proxy-secret", call.proxySecret ?? SECRET);
    headers.set("x-booking-client-ip", call.ip ?? randomIp());
  }
  if (call.cookie) headers.set("cookie", `client_hub_session=${call.cookie}`);
  return new NextRequest(new URL(path, BASE), {
    method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

async function askCode(email: string, call: Call = {}) {
  return json(
    await postCode(
      request("POST", "/api/client-hub/session/code", {
        ...call,
        body: { email },
      }),
    ),
  );
}

function lastCode() {
  const message = transport.sent[transport.sent.length - 1]!;
  return message.subject.slice(0, 8);
}

async function verify(
  challengeId: string,
  email: string,
  code: string,
  call: Call = {},
) {
  const response = await postVerify(
    request("POST", "/api/client-hub/session/verify", {
      ...call,
      body: { challengeId, email, code },
    }),
  );
  const cookie = response.headers.get("set-cookie");
  return {
    ...(await json(response)),
    cookie,
    token: cookie?.match(/client_hub_session=([0-9a-f]{64})/)?.[1] ?? null,
  };
}

/** A full login; the session token. */
async function login(email: string, ip = randomIp()) {
  const asked = await askCode(email, { ip });
  expect(asked.status).toBe(202);
  const verified = await verify(
    asked.body.data.challengeId,
    email,
    lastCode(),
    {
      ip,
    },
  );
  expect(verified.status).toBe(200);
  return verified.token!;
}

const params = <T extends object>(value: T) => ({
  params: Promise.resolve(value),
});

async function me(token: string | null) {
  return json(
    await getMe(request("GET", "/api/client-hub/me", { cookie: token })),
  );
}

async function appointments(
  token: string | null,
  businessId: string,
  query = "scope=upcoming",
) {
  return json(
    await getAppointments(
      request(
        "GET",
        `/api/client-hub/businesses/${businessId}/appointments?${query}`,
        { cookie: token },
      ),
      params({ businessId }) as never,
    ),
  );
}

async function appointment(
  token: string | null,
  businessId: string,
  appointmentId: string,
) {
  return json(
    await getAppointment(
      request(
        "GET",
        `/api/client-hub/businesses/${businessId}/appointments/${appointmentId}`,
        { cookie: token },
      ),
      params({ businessId, appointmentId }) as never,
    ),
  );
}

async function loyalty(token: string | null, businessId: string) {
  return json(
    await getLoyalty(
      request("GET", `/api/client-hub/businesses/${businessId}/loyalty`, {
        cookie: token,
      }),
      params({ businessId }) as never,
    ),
  );
}

async function ledger(token: string | null, businessId: string, query = "") {
  return json(
    await getLedger(
      request(
        "GET",
        `/api/client-hub/businesses/${businessId}/loyalty/ledger?${query}`,
        { cookie: token },
      ),
      params({ businessId }) as never,
    ),
  );
}

const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

type Shop = {
  owner: Professional;
  business: TestBusiness;
  service: string;
};

async function newShop(label: string): Promise<Shop> {
  const owner = await createProfessional(label);
  const business = await createBusiness(owner.userId, {
    name: `Studio ${label}`,
  });
  const service = await createService(business.id, {
    name: "Coupe",
    priceCents: 4500,
  });
  return { owner, business, service };
}

async function visit(
  shop: Shop,
  clientId: string,
  hours: number,
  status: "confirmed" | "completed" | "cancelled" = "confirmed",
) {
  const startsAt = hoursFromNow(hours);
  return insertAppointment({
    businessId: shop.business.id,
    clientId,
    serviceId: shop.service,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
    status,
  });
}

async function grant(shop: Shop, clientId: string, granted = true) {
  sessionClient = shop.owner.client;
  return ok(await setClientHubAccessAction({ clientId, granted }));
}

const email = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}@client.test`;

// ---------------------------------------------------------------------------

describe("passwordless login", () => {
  it("sends an 8-digit code, verifies it once, and opens an HttpOnly session scoped to the hub", async () => {
    const address = email("lea");
    const asked = await askCode(`  ${address.toUpperCase()} `);
    expect(asked).toMatchObject({
      status: 202,
      body: { data: { challengeId: expect.any(String) } },
    });
    expect(transport.sent).toHaveLength(1);
    // The code travels by email only.
    expect(JSON.stringify(asked.body)).not.toContain(`"${lastCode()}"`);
    expect(transport.sent[0]!.idempotencyKey).toBe(
      `client-hub-code-${asked.body.data.challengeId}`,
    );

    const verified = await verify(
      asked.body.data.challengeId,
      address,
      lastCode(),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.data.email).toBe(address);
    expect(verified.cookie).toMatch(/HttpOnly/);
    expect(verified.cookie).toMatch(/SameSite=Lax/);
    expect(verified.cookie).toMatch(/Path=\/api\/client-hub/);

    expect(await me(verified.token)).toEqual({
      status: 200,
      body: { data: { email: address, businesses: [] } },
    });

    // The code was single use.
    const again = await verify(
      asked.body.data.challengeId,
      address,
      lastCode(),
    );
    expect(again).toMatchObject({
      status: 400,
      body: { error: { code: "client_hub_code_invalid" } },
    });
  });

  it("answers the same for an unknown address (no enumeration) and creates no account until verified", async () => {
    const known = email("known");
    await login(known);
    const unknown = email("unknown");
    const a = await askCode(known);
    const b = await askCode(unknown);
    expect(Object.keys(a.body.data).sort()).toEqual(
      Object.keys(b.body.data).sort(),
    );
    expect([a.status, b.status]).toEqual([202, 202]);
    const { rows } = await db.query(
      "select count(*)::int as n from private.client_hub_accounts where email = $1",
      [unknown],
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses wrong, expired, other-address and exhausted codes with one answer", async () => {
    const address = email("wrong");
    const asked = await askCode(address);
    const id = asked.body.data.challengeId;
    const code = lastCode();
    const wrong = code === "00000000" ? "11111111" : "00000000";

    // Another address with the right code.
    expect((await verify(id, email("other"), code)).status).toBe(400);
    // Four wrong codes, then the fifth attempt exhausts the challenge.
    for (let i = 0; i < 3; i += 1) {
      expect((await verify(id, address, wrong)).body.error.code).toBe(
        "client_hub_code_invalid",
      );
    }
    expect((await verify(id, address, wrong)).status).toBe(400);
    // The right code no longer works: 5 attempts were used.
    expect((await verify(id, address, code)).status).toBe(400);

    // Expired.
    const late = await askCode(address);
    await db.query(
      "update private.client_hub_challenges set expires_at = now() - interval '1 second' where id = $1",
      [late.body.data.challengeId],
    );
    expect(
      (await verify(late.body.data.challengeId, address, lastCode())).status,
    ).toBe(400);

    // Unknown challenge, malformed code.
    expect((await verify(randomUUID(), address, code)).status).toBe(400);
    expect((await verify(id, address, "12ab5678")).status).toBe(400);
    expect((await verify(id, address, code.slice(0, 6))).status).toBe(400);
  });

  it("a successful login invalidates the other open codes of the address", async () => {
    const address = email("open");
    const first = await askCode(address);
    const firstCode = lastCode();
    const second = await askCode(address);
    expect(
      (await verify(second.body.data.challengeId, address, lastCode())).status,
    ).toBe(200);
    expect(
      (await verify(first.body.data.challengeId, address, firstCode)).status,
    ).toBe(400);
  });

  it("concurrent verifications of one code open exactly one session", async () => {
    const address = email("race");
    const asked = await askCode(address);
    const code = lastCode();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        verify(asked.body.data.challengeId, address, code),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const { rows } = await db.query(
      `select count(*)::int as n from private.client_hub_sessions s
       join private.client_hub_accounts a on a.id = s.account_id where a.email = $1`,
      [address],
    );
    expect(rows[0].n).toBe(1);
  });

  it("rate-limits code requests per address (all networks), also under concurrency", async () => {
    const address = email("limit");
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => askCode(address, { ip: randomIp() })),
    );
    expect(burst.filter((r) => r.status === 202)).toHaveLength(10);
    expect(
      burst.filter((r) => r.body.error?.code === "rate_limited"),
    ).toHaveLength(2);
    expect(transport.sent).toHaveLength(10);
  });

  it("one network cannot use up someone else's allowance: per (address, network) and per network limits", async () => {
    const victim = email("victim-lock");
    const attacker = randomIp();
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await askCode(victim, { ip: attacker })).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
    // The victim, from her own network, still gets a code.
    expect((await askCode(victim, { ip: randomIp() })).status).toBe(202);

    const network = randomIp();
    const perNetwork = [];
    for (let i = 0; i < 11; i += 1) {
      perNetwork.push((await askCode(email(`n${i}`), { ip: network })).status);
    }
    expect(perNetwork.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(perNetwork[10]).toBe(429);
  });

  it("sends the code only to the canonical address it is bound to; non-ASCII addresses are refused", async () => {
    const address = email("canon");
    expect((await askCode(`  ${address.toUpperCase()}  `)).status).toBe(202);
    expect(transport.sent[0]!.to).toBe(address);
    for (const odd of [`lea@gma\u0130l.com`, "léa@client.test"]) {
      expect(await askCode(odd)).toMatchObject({
        status: 400,
        body: { error: { code: "validation_error" } },
      });
    }
    expect(transport.sent).toHaveLength(1);
  });

  it("refuses cross-site requests: no login CSRF, no session set, no code sent", async () => {
    const address = email("csrf");
    const asked = await askCode(address);
    const code = lastCode();
    for (const headers of [
      { "content-type": "text/plain" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
    ]) {
      const forged = request("POST", "/api/client-hub/session/verify", {
        body: {
          challengeId: asked.body.data.challengeId,
          email: address,
          code,
        },
      });
      for (const [name, value] of Object.entries(headers)) {
        forged.headers.set(name, value);
      }
      const response = await postVerify(forged);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const forgedCode = request("POST", "/api/client-hub/session/code", {
      body: { email: email("csrf-code") },
    });
    forgedCode.headers.set("sec-fetch-site", "cross-site");
    expect((await postCode(forgedCode)).status).toBe(403);
    expect(transport.sent).toHaveLength(1);
    // The same request from the app itself still works.
    const sameSite = request("POST", "/api/client-hub/session/verify", {
      body: { challengeId: asked.body.data.challengeId, email: address, code },
    });
    sameSite.headers.set("sec-fetch-site", "same-origin");
    sameSite.headers.set("origin", "http://localhost:3000");
    expect((await postVerify(sameSite)).status).toBe(200);
  });

  it("two verifications of one code interleaved: the second, after the first commits, is refused (row lock)", async () => {
    const address = email("lock");
    const asked = await askCode(address);
    const code = lastCode();
    // Two networks: only the challenge's row lock orders them (not the
    // per-network advisory lock).
    const call =
      "select status from public.client_hub_verify_code($1, $2, $3, $4)";
    const first = await openTransaction({ role: "service_role" });
    const second = await openTransaction({ role: "service_role" });
    const firstResult = await first.connection.query(call, [
      asked.body.data.challengeId,
      address,
      code,
      "198.51.100.7",
    ]);
    expect(firstResult.rows[0].status).toBe("ok");
    const pending = second.connection.query(call, [
      asked.body.data.challengeId,
      address,
      code,
      "198.51.100.8",
    ]);
    await waitUntilBlocked(second.pid);
    await closeTransaction(first, "commit");
    expect((await pending).rows[0].status).toBe("invalid");
    await closeTransaction(second, "commit");
  });

  it("rate-limits failed verifications per network, even with the right code afterwards", async () => {
    const ip = randomIp();
    for (let i = 0; i < 20; i += 1) {
      await verify(randomUUID(), email("brute"), "12345678", { ip });
    }
    const address = email("victim");
    const asked = await askCode(address);
    const blocked = await verify(
      asked.body.data.challengeId,
      address,
      lastCode(),
      {
        ip,
      },
    );
    expect(blocked).toMatchObject({
      status: 429,
      body: { error: { code: "rate_limited" } },
    });
  });

  it("issues nothing without email delivery or without the trusted ingress", async () => {
    configured = null;
    const address = email("off");
    expect(await askCode(address)).toMatchObject({
      status: 503,
      body: { error: { code: "client_hub_unavailable" } },
    });
    configured = { transport, from: "Booking <noreply@test.local>" };
    expect((await askCode(address, { proxySecret: null })).status).toBe(503);
    expect(
      (await askCode(address, { proxySecret: "x".repeat(40) })).status,
    ).toBe(503);
    const { rows } = await db.query(
      "select count(*)::int as n from private.client_hub_challenges where email = $1",
      [address],
    );
    expect(rows[0].n).toBe(0);
  });

  it("a failed send is reported, never answered as sent", async () => {
    transport.failNext("provider_down", "retry");
    expect(await askCode(email("down"))).toMatchObject({
      status: 503,
      body: { error: { code: "client_hub_unavailable" } },
    });
  });
});

describe("sessions", () => {
  it("end on logout (one, or all of the account) and reject forged tokens", async () => {
    const address = email("session");
    const first = await login(address);
    const second = await login(address);
    const third = await login(address);

    const out = await deleteSession(
      request("DELETE", "/api/client-hub/session", { cookie: first }),
    );
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);

    await deleteSession(
      request("DELETE", "/api/client-hub/session?all=true", { cookie: second }),
    );
    expect((await me(second)).status).toBe(401);
    expect((await me(third)).status).toBe(401);

    expect((await me("f".repeat(64))).status).toBe(401);
    // Two cookies of the session's name: refused, not guessed between.
    const doubled = request("GET", "/api/client-hub/me");
    doubled.headers.set(
      "cookie",
      `client_hub_session=${third}; client_hub_session=${"e".repeat(64)}`,
    );
    expect((await getMe(doubled)).status).toBe(401);
    expect((await me("not-a-token")).status).toBe(401);
    expect((await me(null)).body.error.code).toBe("client_hub_unauthenticated");
  });

  it("expire: an expired session is refused, and the refusal never deletes a cookie", async () => {
    const token = await login(email("expiry"));
    expect((await me(token)).status).toBe(200);
    await db.query(
      `update private.client_hub_sessions set expires_at = now() - interval '1 second'
       where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
      [token],
    );
    const expired = await getMe(
      request("GET", "/api/client-hub/me", { cookie: token }),
    );
    expect(expired.status).toBe(401);
    expect(expired.headers.get("cache-control")).toBe("no-store");
    // A deletion names the cookie, not its value: sent with a refused read,
    // it would erase a newer session of the same browser (see below).
    expect(expired.headers.getSetCookie()).toEqual([]);
  });

  it("a late 401 of A's read, after B signed in on the same browser, leaves B's cookie and session working", async () => {
    const jar = new CookieJar();
    const tokenA = await login(email("late-a"));
    jar.set(
      `client_hub_session=${tokenA}; Path=/api/client-hub; HttpOnly; SameSite=Lax; Max-Age=600`,
    );

    // A's session ends (signed out elsewhere); a read of A is refused, and
    // its answer is held until after B signed in.
    await deleteSession(
      request("DELETE", "/api/client-hub/session", { cookie: tokenA }),
    );
    const lateA = await getMe(
      request("GET", "/api/client-hub/me", { cookie: tokenA }),
    );
    expect(lateA.status).toBe(401);

    // B signs in on the same browser: the verify route's real Set-Cookie.
    const address = email("late-b");
    const asked = await askCode(address);
    const verified = await postVerify(
      request("POST", "/api/client-hub/session/verify", {
        body: {
          challengeId: asked.body.data.challengeId,
          email: address,
          code: lastCode(),
        },
      }),
    );
    expect(verified.status).toBe(200);
    jar.apply(verified);
    const tokenB = jar.get("client_hub_session")!.value;
    expect(tokenB).not.toBe(tokenA);

    // A's late 401 reaches the browser now.
    jar.apply(lateA);
    expect(jar.get("client_hub_session")?.value).toBe(tokenB);
    const meB = await me(tokenB);
    expect(meB.status).toBe(200);
    expect(meB.body.data.email).toBe(address);
    // A's session stays refused by the backend.
    expect((await me(tokenA)).status).toBe(401);
  });

  it("a revoked session (signed out everywhere) stays refused, without any cookie deletion on reads", async () => {
    const address = email("revoked");
    const one = await login(address);
    const two = await login(address);
    await deleteSession(
      request("DELETE", "/api/client-hub/session?all=true", { cookie: one }),
    );
    for (const token of [one, two]) {
      const refused = await getMe(
        request("GET", "/api/client-hub/me", { cookie: token }),
      );
      expect(refused.status).toBe(401);
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
  });

  it("sessions ended more than a day ago are purged", async () => {
    const token = await login(email("purge"));
    await db.query(
      `update private.client_hub_sessions set expires_at = now() - interval '2 days'
       where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
      [token],
    );
    await askCode(email("purge-trigger"));
    const { rows } = await db.query(
      `select count(*)::int as n from private.client_hub_sessions
       where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
      [token],
    );
    expect(rows[0].n).toBe(0);
  });

  it("sessions last 7 days and only their hash is stored", async () => {
    const address = email("hash");
    const token = await login(address);
    const { rows } = await db.query(
      `select s.token_hash, extract(epoch from s.expires_at - s.created_at)::int as seconds
       from private.client_hub_sessions s
       join private.client_hub_accounts a on a.id = s.account_id where a.email = $1`,
      [address],
    );
    expect(rows[0].seconds).toBe(7 * 24 * 3600);
    expect(rows[0].token_hash).not.toBe(token);
    const { rows: anywhere } = await db.query(
      `select count(*)::int as n from private.client_hub_sessions where token_hash = $1`,
      [token],
    );
    expect(anywhere[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("identity linking and authorization", () => {
  let a: Shop;
  let b: Shop;
  let lea: string;
  let leaA: string;
  let leaB: string;
  let otherA: string;
  let upcomingA: string;
  let pastA: string;
  let upcomingB: string;
  let otherUpcomingA: string;
  let token: string;

  beforeAll(async () => {
    a = await newShop("hub-a");
    b = await newShop("hub-b");
    lea = email("lea-multi");
    leaA = await createClientRecord(a.business.id, lea, "Léa");
    leaB = await createClientRecord(b.business.id, lea, "Léa B");
    otherA = await createClientRecord(a.business.id, email("other"), "Autre");
    // Contact snapshots are taken at insertion, from the record.
    await db.query(
      "update public.clients set phone = '+33 6 00 00 00 00' where id = $1",
      [leaA],
    );
    upcomingA = await visit(a, leaA, 48);
    pastA = await visit(a, leaA, -48, "completed");
    upcomingB = await visit(b, leaB, 72);
    otherUpcomingA = await visit(a, otherA, 96);
    await db.query(
      `update public.appointments
       set internal_notes = 'Allergique, tarif ami'
       where id = $1`,
      [upcomingA],
    );
    // One login for the whole block: authorizations apply to live sessions.
    token = await login(lea);
  });

  it("an email match alone shows nothing: no business, no appointment, not even its existence", async () => {
    expect((await me(token)).body.data.businesses).toEqual([]);
    for (const response of [
      await appointments(token, a.business.id),
      await appointment(token, a.business.id, upcomingA),
      await loyalty(token, a.business.id),
      await ledger(token, a.business.id),
    ]) {
      expect(response).toMatchObject({
        status: 404,
        body: { error: { code: "client_hub_not_found" } },
      });
    }
  });

  it("a historical booking made publicly with someone's email is not revealed to them by login", async () => {
    const shop = await newShop("hub-public");
    await setWeeklyHours(shop.business.id, everyDay(["08:00", "20:00"]));
    const victim = email("victim");
    await createPublicBooking(
      bookingClient(),
      bookingRequest({
        slug: shop.business.slug,
        serviceId: shop.service,
        startsAt: `${dateInDays(5)}T10:00:00.000Z`,
        firstName: "Usurpatrice",
        email: victim,
      }),
      randomIp(),
    );
    const token = await login(victim);
    expect((await me(token)).body.data.businesses).toEqual([]);
    expect((await appointments(token, shop.business.id)).status).toBe(404);
  });

  it("once the professional authorizes the record, its appointments are visible, without private fields", async () => {
    await grant(a, leaA);
    const profile = (await me(token)).body.data;
    expect(profile.businesses).toEqual([
      {
        businessId: a.business.id,
        name: "Studio hub-a",
        slug: a.business.slug,
        timezone: "Europe/Paris",
        location: null,
        customer: { firstName: "Léa", lastName: null },
      },
    ]);

    const upcoming = await appointments(token, a.business.id);
    expect(upcoming.status).toBe(200);
    expect(upcoming.body.data.items.map((i: { id: string }) => i.id)).toEqual([
      upcomingA,
    ]);
    expect(Object.keys(upcoming.body.data.items[0]).sort()).toEqual([
      "currency",
      "durationMinutes",
      "endsAt",
      "id",
      "priceCents",
      "serviceName",
      "startsAt",
      "status",
    ]);
    const past = await appointments(token, a.business.id, "scope=past");
    expect(past.body.data.items.map((i: { id: string }) => i.id)).toEqual([
      pastA,
    ]);

    const detail = await appointment(token, a.business.id, upcomingA);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(
      /Allergique|\+33|internal|contact|clientId|createdBy/i,
    );
    expect(detail.body.data.business).toMatchObject({
      name: "Studio hub-a",
    });
  });

  it("never another customer's appointment, nor another business's, whatever the ids", async () => {
    await grant(a, leaA);
    for (const [business, id] of [
      [a.business.id, otherUpcomingA],
      [a.business.id, upcomingB],
      [b.business.id, upcomingB],
      [b.business.id, upcomingA],
      [randomUUID(), upcomingA],
      ["not-a-uuid", upcomingA],
    ] as const) {
      expect((await appointment(token, business, id)).status).toBe(404);
    }
    // B was not authorized: nothing from B.
    expect((await appointments(token, b.business.id)).status).toBe(404);
    expect((await loyalty(token, b.business.id)).status).toBe(404);
  });

  it("several businesses: each authorized relationship separately, never mixed", async () => {
    await grant(a, leaA);
    await grant(b, leaB);
    expect(
      (await me(token)).body.data.businesses
        .map((x: { businessId: string }) => x.businessId)
        .sort(),
    ).toEqual([a.business.id, b.business.id].sort());
    expect(
      (await appointments(token, b.business.id)).body.data.items.map(
        (i: { id: string }) => i.id,
      ),
    ).toEqual([upcomingB]);
    expect(
      (await appointments(token, a.business.id)).body.data.items.map(
        (i: { id: string }) => i.id,
      ),
    ).toEqual([upcomingA]);
    await grant(b, leaB, false);
  });

  it("revocation, or a change of the record's email, ends access at once; regranting vouches for the new email", async () => {
    const shop = await newShop("hub-revoke");
    const address = email("revoke");
    const client = await createClientRecord(shop.business.id, address, "Rose");
    await visit(shop, client, 30);
    await grant(shop, client);
    const token = await login(address);
    expect((await appointments(token, shop.business.id)).status).toBe(200);

    await grant(shop, client, false);
    expect((await appointments(token, shop.business.id)).status).toBe(404);
    await grant(shop, client);
    expect((await appointments(token, shop.business.id)).status).toBe(200);

    // The professional changes the record's email: the access is revoked;
    // the new address gets none without a new authorization.
    const next = email("revoke-next");
    await db.query("update public.clients set email = $2 where id = $1", [
      client,
      next,
    ]);
    expect((await appointments(token, shop.business.id)).status).toBe(404);
    sessionClient = shop.owner.client;
    expect(
      ok(await getClientHubAccessAction({ clientId: client })),
    ).toMatchObject({ granted: false, email: null });
    const nextToken = await login(next);
    expect((await appointments(nextToken, shop.business.id)).status).toBe(404);

    // A grant shown with the former email is refused (it changed meanwhile).
    sessionClient = shop.owner.client;
    expect(
      await setClientHubAccessAction({
        clientId: client,
        granted: true,
        expectedEmail: address,
      }),
    ).toMatchObject({ ok: false, error: { code: "stale_client" } });
    expect(
      ok(
        await setClientHubAccessAction({
          clientId: client,
          granted: true,
          expectedEmail: next.toUpperCase(),
        }),
      ),
    ).toMatchObject({ granted: true, email: next });
    expect((await appointments(nextToken, shop.business.id)).status).toBe(200);
    expect((await appointments(token, shop.business.id)).status).toBe(404);

    // Reverting the email revokes again, and does not revive the old grant.
    await db.query("update public.clients set email = $2 where id = $1", [
      client,
      address,
    ]);
    expect((await appointments(token, shop.business.id)).status).toBe(404);
    expect((await appointments(nextToken, shop.business.id)).status).toBe(404);
  });

  it("only a member of the business can authorize, and only with an email on the record", async () => {
    sessionClient = b.owner.client;
    expect(
      await setClientHubAccessAction({ clientId: leaA, granted: true }),
    ).toMatchObject({ ok: false, error: { code: "client_not_found" } });
    const { error } = await b.owner.client.rpc("client_hub_set_access", {
      p_business_id: a.business.id,
      p_client_id: leaA,
      p_granted: true,
    });
    expect(error?.message).toBe("forbidden");
    const anon = await anonClient().rpc("client_hub_set_access", {
      p_business_id: a.business.id,
      p_client_id: leaA,
      p_granted: true,
    });
    expect(anon.error?.code).toBe("42501");

    const noEmail = (
      await db.query<{ id: string }>(
        "insert into public.clients (business_id, first_name) values ($1, 'Sans email') returning id",
        [a.business.id],
      )
    ).rows[0]!.id;
    sessionClient = a.owner.client;
    expect(
      await setClientHubAccessAction({ clientId: noEmail, granted: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "client_hub_email_required" },
    });
  });

  it("customers and professionals never cross: no hub function for Supabase sessions, no table for the hub", async () => {
    for (const client of [a.owner.client, anonClient()]) {
      const profile = await client.rpc("client_hub_profile", {
        p_session_token: token,
      });
      expect(profile.error?.code).toBe("42501");
      const code = await client.rpc("client_hub_request_code", {
        p_email: lea,
        p_client_ip: "203.0.113.1",
      });
      expect(code.error?.code).toBe("42501");
    }
    // The customer session is not a Supabase session.
    sessionClient = anonClient();
    expect(await getClientHubAccessAction({ clientId: leaA })).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    // Grants are visible to the business's members only.
    const own = await a.owner.client.from("client_hub_access").select("*");
    const foreign = await b.owner.client
      .from("client_hub_access")
      .select("*")
      .eq("business_id", a.business.id);
    expect(own.data?.length).toBeGreaterThan(0);
    expect(foreign.data).toEqual([]);
    const write = await a.owner.client
      .from("client_hub_access")
      .update({ email: "attacker@x.test" })
      .eq("client_id", leaA)
      .select();
    expect(
      write.error?.code ?? (write.data?.length === 0 ? "none" : "written"),
    ).toMatch(/42501|none/);
  });

  it("no privilege beyond the service role on customer functions; private tables unreachable", async () => {
    const { rows } = await db.query(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service,
              p.prosecdef, coalesce(p.proconfig, '{}') @> array['search_path=""'] as pinned
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'client_hub_%'
       order by p.proname`,
    );
    for (const row of rows) {
      expect(row.anon, row.proname).toBe(false);
      expect(row.prosecdef && row.pinned, row.proname).toBe(true);
      expect(row.authenticated, row.proname).toBe(
        row.proname === "client_hub_set_access",
      );
      if (row.proname !== "client_hub_set_access") {
        expect(row.service, row.proname).toBe(true);
      }
    }
    const { rows: tables } = await db.query(
      `select c.relname,
              has_table_privilege('authenticated', c.oid, 'select') as auth,
              has_table_privilege('anon', c.oid, 'select') as anon
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'private' and c.relname like 'client_hub_%' and c.relkind = 'r'`,
    );
    expect(tables.length).toBe(4);
    expect(tables.every((t) => !t.auth && !t.anon)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("loyalty in the hub", () => {
  let shop: Shop;
  let address: string;
  let client: string;
  let token: string;
  let reward: string;

  beforeAll(async () => {
    shop = await newShop("hub-loyalty");
    // Ledger entries of another business first: this customer's positions
    // then differ from the global ledger sequence.
    const elsewhere = await newShop("hub-loyalty-other");
    const stranger = await createClientRecord(
      elsewhere.business.id,
      email("stranger"),
    );
    await db.query(
      `insert into public.loyalty_events
         (business_id, client_id, type, points_delta, reason, idempotency_key)
       select $1, $2, 'manual_adjustment', 1, 'x', 'other-' || g
       from generate_series(1, 40) g`,
      [elsewhere.business.id, stranger],
    );
    address = email("points");
    client = await createClientRecord(shop.business.id, address, "Iris");
    await db.query(
      `insert into public.loyalty_programs (business_id, active) values ($1, true)
       on conflict (business_id) do update set active = true`,
      [shop.business.id],
    );
    await db.query(
      `insert into public.loyalty_events
         (business_id, client_id, type, points_delta, reason, idempotency_key)
       select $1, $2, 'manual_adjustment', 5, 'Cliente pénible, geste forcé ' || g, 'k' || g
       from generate_series(1, 25) g`,
      [shop.business.id, client],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into public.rewards (business_id, name, points_required, reward_type, reward_value)
       values ($1, 'Remise 10 %', 100, 'percentage_discount', 10),
              ($1, 'Trop cher', 1000, 'percentage_discount', 20)
       returning id`,
      [shop.business.id],
    );
    reward = rows[0]!.id;
    await db.query(
      `insert into public.rewards (business_id, name, points_required, reward_type, reward_value, active)
       values ($1, 'Désactivée', 1, 'percentage_discount', 5, false)`,
      [shop.business.id],
    );
    sessionClient = shop.owner.client;
    const { error } = await shop.owner.client.rpc("loyalty_redeem_reward", {
      p_business_id: shop.business.id,
      p_client_id: client,
      p_reward_id: reward,
      p_request_id: randomUUID(),
    });
    expect(error).toBeNull();
    await grant(shop, client);
    token = await login(address);
  });

  it("balance, active rewards with eligibility, and issued rewards; nothing to redeem", async () => {
    const response = await loyalty(token, shop.business.id);
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({ programActive: true, balance: 25 });
    expect(data.rewards.map((r: { name: string }) => r.name)).toEqual([
      "Remise 10 %",
      "Trop cher",
    ]);
    expect(data.rewards[0]).toMatchObject({
      eligible: false,
      missingPoints: 75,
    });
    expect(data.issuedRewards).toEqual([
      expect.objectContaining({
        status: "issued",
        name: "Remise 10 %",
        pointsSpent: 100,
      }),
    ]);
  });

  it("the ledger is paginated, newest first, and never carries the professional's free text", async () => {
    const first = await ledger(token, shop.business.id, "limit=20");
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(20);
    expect(first.body.data.items[0]).toMatchObject({
      type: "reward_redeemed",
      pointsDelta: -100,
      balanceAfter: 25,
      rewardName: "Remise 10 %",
    });
    expect(JSON.stringify(first.body)).not.toMatch(/pénible|forcé|reason|seq/);
    // The cursor is a position in this customer's ledger (26 entries: the
    // last of the first page is the 7th), never the global sequence.
    expect(first.body.data.nextCursor).toBe("7");
    const second = await ledger(
      token,
      shop.business.id,
      `limit=20&cursor=${first.body.data.nextCursor}`,
    );
    expect(second.body.data.items).toHaveLength(6);
    expect(second.body.data.nextCursor).toBeNull();
    const ids = [...first.body.data.items, ...second.body.data.items].map(
      (i: { id: string }) => i.id,
    );
    expect(new Set(ids).size).toBe(26);
    expect((await ledger(token, shop.business.id, "limit=51")).status).toBe(
      400,
    );
  });

  it("reading the hub writes nothing: appointments, ledger and redemptions unchanged", async () => {
    const snapshot = async () =>
      (
        await db.query(
          `select
             (select md5(coalesce(string_agg(e::text, '|' order by e.id), '')) from public.loyalty_events e where e.business_id = $1) as ledger,
             (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.reward_redemptions r where r.business_id = $1) as redemptions,
             (select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) from public.appointments a where a.business_id = $1) as appointments,
             (select md5(c::text) from public.clients c where c.id = $2) as client`,
          [shop.business.id, client],
        )
      ).rows[0];
    const before = await snapshot();
    await loyalty(token, shop.business.id);
    await ledger(token, shop.business.id);
    await appointments(token, shop.business.id);
    await appointments(token, shop.business.id, "scope=past");
    await me(token);
    expect(await snapshot()).toEqual(before);
  });
});

describe("appointment pagination", () => {
  it("pages of 3 over 8 upcoming appointments: every one once, soonest first", async () => {
    const shop = await newShop("hub-pages");
    const address = email("pages");
    const client = await createClientRecord(shop.business.id, address, "Nina");
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1)
      ids.push(await visit(shop, client, 24 + i * 3));
    await grant(shop, client);
    const token = await login(address);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await appointments(
        token,
        shop.business.id,
        `scope=upcoming&limit=3${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.data.items.map((i: { id: string }) => i.id));
      cursor = page.body.data.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
    expect(
      (await appointments(token, shop.business.id, "scope=upcoming&cursor=bad"))
        .status,
    ).toBe(400);
    expect(
      (await appointments(token, shop.business.id, "scope=all")).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Concurrency and session authority (corrections after the Codex audit).
// Real PostgreSQL connections, interleaved deterministically.
// ---------------------------------------------------------------------------

const VERIFY_SQL =
  "select status from public.client_hub_verify_code($1, $2, $3, $4)";

/** The verification's status, or `error:<message>` (never rejects). */
function settle(query: Promise<{ rows: { status: string }[] }>) {
  return query.then(
    (result) => result.rows[0]!.status,
    (error: { message: string }) => `error:${error.message}`,
  );
}

async function sessionCount(address: string) {
  const { rows } = await db.query(
    `select count(*)::int as n from private.client_hub_sessions s
     join private.client_hub_accounts a on a.id = s.account_id
     where a.email = $1`,
    [address],
  );
  return rows[0].n as number;
}

async function logout(token: string | null, all = false) {
  const response = await deleteSession(
    request("DELETE", `/api/client-hub/session${all ? "?all=true" : ""}`, {
      cookie: token,
    }),
  );
  return { status: response.status, body: await response.json() };
}

describe("verification concurrency (lock order: network → address → challenge)", () => {
  it("two valid codes of one address verified at once from two networks: no deadlock, exactly one session", async () => {
    const address = email("deadlock");
    const x = await askCode(address);
    const codeX = lastCode();
    const y = await askCode(address);
    const codeY = lastCode();
    const ids = [x.body.data.challengeId, y.body.data.challengeId];

    // A third transaction holds both challenges, so that both verifications
    // are released at the same moment: without the address lock, each then
    // locks its own challenge and waits for the other's (40P01).
    const holder = await openTransaction();
    await holder.connection.query(
      "select id from private.client_hub_challenges where id = any($1) for update",
      [ids],
    );
    const a = await openTransaction({ role: "service_role" });
    const b = await openTransaction({ role: "service_role" });
    const first = settle(
      a.connection.query(VERIFY_SQL, [ids[0], address, codeX, "198.51.100.21"]),
    );
    await waitUntilBlocked(a.pid);
    const second = settle(
      b.connection.query(VERIFY_SQL, [ids[1], address, codeY, "198.51.100.22"]),
    );
    await waitUntilBlocked(b.pid);
    await closeTransaction(holder, "commit");

    // The first commits before the second can take the address lock.
    const firstResult = await first;
    await closeTransaction(
      a,
      firstResult.startsWith("error") ? "rollback" : "commit",
    );
    const secondResult = await second;
    await closeTransaction(
      b,
      secondResult.startsWith("error") ? "rollback" : "commit",
    );
    const results = [firstResult, secondResult];

    expect(results.sort()).toEqual(["invalid", "ok"]);
    expect(await sessionCount(address)).toBe(1);
  });

  it("many valid codes of one address verified at once through the API: one session, no internal error", async () => {
    const address = email("burst");
    const pairs: [string, string][] = [];
    for (let i = 0; i < 3; i += 1) {
      const asked = await askCode(address);
      pairs.push([asked.body.data.challengeId, lastCode()]);
    }
    const results = await Promise.all(
      pairs.flatMap(([id, code]) => [
        verify(id, address, code),
        verify(id, address, code),
      ]),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      200, 400, 400, 400, 400, 400,
    ]);
    expect(await sessionCount(address)).toBe(1);
  });

  it("concurrent wrong codes never buy more than 5 attempts, from any number of networks", async () => {
    const address = email("attempts");
    const asked = await askCode(address);
    const id = asked.body.data.challengeId;
    const code = lastCode();
    const wrong = code === "00000000" ? "11111111" : "00000000";
    const failures = await Promise.all(
      Array.from({ length: 5 }, () => verify(id, address, wrong)),
    );
    expect(failures.every((f) => f.status === 400)).toBe(true);
    const { rows } = await db.query(
      "select attempts from private.client_hub_challenges where id = $1",
      [id],
    );
    expect(rows[0].attempts).toBe(5);
    expect((await verify(id, address, code)).status).toBe(400);

    // Four concurrent failures leave the fifth attempt to the right code.
    const again = await askCode(address);
    const againCode = lastCode();
    const againWrong = againCode === "00000000" ? "11111111" : "00000000";
    await Promise.all(
      Array.from({ length: 4 }, () =>
        verify(again.body.data.challengeId, address, againWrong),
      ),
    );
    expect(
      (await verify(again.body.data.challengeId, address, againCode)).status,
    ).toBe(200);
  });

  it("a code requested while another is being verified waits for it, then is valid on its own", async () => {
    const address = email("issue");
    const asked = await askCode(address);
    const code = lastCode();
    const a = await openTransaction({ role: "service_role" });
    expect(
      await settle(
        a.connection.query(VERIFY_SQL, [
          asked.body.data.challengeId,
          address,
          code,
          "198.51.100.31",
        ]),
      ),
    ).toBe("ok");

    let settled = false;
    const requested = askCode(address).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settled).toBe(false); // serialized on the address
    await closeTransaction(a, "commit");
    const issued = await requested;
    expect(issued.status).toBe(202);
    // Issued after the login: not invalidated by it.
    expect(
      (await verify(issued.body.data.challengeId, address, lastCode())).status,
    ).toBe(200);
  });

  it("two different addresses are not serialized against each other", async () => {
    const first = email("free-a");
    const second = email("free-b");
    const askedA = await askCode(first);
    const codeA = lastCode();
    const askedB = await askCode(second);
    const codeB = lastCode();
    const a = await openTransaction({ role: "service_role" });
    const b = await openTransaction({ role: "service_role" });
    expect(
      await settle(
        a.connection.query(VERIFY_SQL, [
          askedA.body.data.challengeId,
          first,
          codeA,
          "198.51.100.41",
        ]),
      ),
    ).toBe("ok");
    // While the first transaction still holds its locks.
    const other = await Promise.race([
      settle(
        b.connection.query(VERIFY_SQL, [
          askedB.body.data.challengeId,
          second,
          codeB,
          "198.51.100.42",
        ]),
      ),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
    ]);
    expect(other).toBe("ok");
    await closeTransaction(a, "commit");
    await closeTransaction(b, "commit");
  });
});

describe("logout authority", () => {
  it("an active session ends every session of its own account, and only of it", async () => {
    const address = email("all-active");
    const t1 = await login(address);
    const t2 = await login(address);
    const stranger = await login(email("all-other"));
    expect(await logout(t1, true)).toEqual({
      status: 200,
      body: { data: { ended: true } },
    });
    expect((await me(t1)).status).toBe(401);
    expect((await me(t2)).status).toBe(401);
    expect((await me(stranger)).status).toBe(200);
  });

  it("a revoked session has no authority left: a global logout with it ends nothing", async () => {
    const address = email("revoked-authority");
    const t1 = await login(address);
    await logout(t1);
    const t2 = await login(address);
    expect((await me(t2)).status).toBe(200);

    // Same answer as for any other call: nothing tells the token is stale.
    expect(await logout(t1, true)).toEqual({
      status: 200,
      body: { data: { ended: true } },
    });
    expect((await me(t2)).status).toBe(200);
  });

  it("an expired session has no authority left either", async () => {
    const address = email("expired-authority");
    const t1 = await login(address);
    await db.query(
      `update private.client_hub_sessions set expires_at = now() - interval '1 second'
       where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
      [t1],
    );
    const t2 = await login(address);
    expect((await logout(t1, true)).status).toBe(200);
    expect((await me(t2)).status).toBe(200);
  });

  it("an unknown token ends nothing; a repeated single logout is a quiet success", async () => {
    const address = email("unknown-authority");
    const t1 = await login(address);
    const t2 = await login(address);
    expect((await logout("c".repeat(64), true)).status).toBe(200);
    expect((await me(t1)).status).toBe(200);

    expect(await logout(t1)).toEqual({
      status: 200,
      body: { data: { ended: true } },
    });
    expect(await logout(t1)).toEqual({
      status: 200,
      body: { data: { ended: true } },
    });
    expect((await me(t1)).status).toBe(401);
    expect((await me(t2)).status).toBe(200);
  });

  it("a global logout racing the revocation of its own session waits for it, then ends nothing", async () => {
    const address = email("race-authority");
    const t1 = await login(address);
    const t2 = await login(address);
    const revoke = await openTransaction({ role: "service_role" });
    const global = await openTransaction({ role: "service_role" });
    await revoke.connection.query(
      "select public.client_hub_end_session($1, false)",
      [t1],
    );
    const pending = global.connection
      .query("select public.client_hub_end_session($1, true)", [t1])
      .then(
        () => "ok",
        (error: { message: string }) => error.message,
      );
    await waitUntilBlocked(global.pid);
    await closeTransaction(revoke, "commit");
    expect(await pending).toBe("ok");
    await closeTransaction(global, "commit");
    expect((await me(t1)).status).toBe(401);
    expect((await me(t2)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Global logouts racing each other (correction after the second Codex
// audit). Lock order of client_hub_end_session: account (advisory), then
// the calling session's row; only live sessions are revoked.
// ---------------------------------------------------------------------------

const END_SQL = "select public.client_hub_end_session($1, $2)";

function settleEnd(query: Promise<unknown>) {
  return query.then(
    () => "ok",
    (error: { message: string }) => `error:${error.message}`,
  );
}

async function activeSessions(address: string) {
  const { rows } = await db.query(
    `select count(*)::int as n from private.client_hub_sessions s
     join private.client_hub_accounts a on a.id = s.account_id
     where a.email = $1 and s.revoked_at is null and s.expires_at > now()`,
    [address],
  );
  return rows[0].n as number;
}

const hashOf = (token: string) =>
  db
    .query<{ id: string }>(
      `select id from private.client_hub_sessions
       where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
      [token],
    )
    .then((result) => result.rows[0]!.id);

describe("concurrent global logouts", () => {
  it("two sessions of one account log out everywhere at the same moment: no deadlock, every session ended", async () => {
    const address = email("double-global");
    const t1 = await login(address);
    const t2 = await login(address);
    const t3 = await login(address);

    // A third transaction holds both callers' rows, so that both calls are
    // released at the same moment: without the account lock each then
    // holds its own row and waits for the other's (40P01).
    const holder = await openTransaction();
    await holder.connection.query(
      "select id from private.client_hub_sessions where id = any($1) for update",
      [[await hashOf(t1), await hashOf(t2)]],
    );
    const a = await openTransaction({ role: "service_role" });
    const b = await openTransaction({ role: "service_role" });
    const first = settleEnd(a.connection.query(END_SQL, [t1, true]));
    await waitUntilBlocked(a.pid);
    const second = settleEnd(b.connection.query(END_SQL, [t2, true]));
    await waitUntilBlocked(b.pid);
    await closeTransaction(holder, "commit");

    const firstResult = await first;
    await closeTransaction(a, firstResult === "ok" ? "commit" : "rollback");
    const secondResult = await second;
    await closeTransaction(b, secondResult === "ok" ? "commit" : "rollback");

    expect([firstResult, secondResult]).toEqual(["ok", "ok"]);
    expect(await activeSessions(address)).toBe(0);
    expect((await me(t3)).status).toBe(401);
  });

  it("ordinary concurrent global logouts through the API: all answer 200, all sessions ended", async () => {
    const address = email("burst-global");
    const tokens: string[] = [];
    for (let i = 0; i < 5; i += 1) tokens.push(await login(address));
    const results = await Promise.all(
      tokens.map((token) => logout(token, true)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await activeSessions(address)).toBe(0);
  });

  it("a single logout and a global logout racing: both end cleanly, nothing stays active", async () => {
    const address = email("single-global");
    const t1 = await login(address);
    const t2 = await login(address);
    const single = await openTransaction({ role: "service_role" });
    const global = await openTransaction({ role: "service_role" });
    expect(await settleEnd(single.connection.query(END_SQL, [t1, false]))).toBe(
      "ok",
    );
    const pending = settleEnd(global.connection.query(END_SQL, [t2, true]));
    await waitUntilBlocked(global.pid); // the account lock
    await closeTransaction(single, "commit");
    expect(await pending).toBe("ok");
    await closeTransaction(global, "commit");
    expect(await activeSessions(address)).toBe(0);
  });

  it("a global logout racing a new login: neither blocks the other; the new session survives", async () => {
    const address = email("login-global");
    const t1 = await login(address);
    const asked = await askCode(address);
    const code = lastCode();
    const verifying = await openTransaction({ role: "service_role" });
    const { rows } = await verifying.connection.query(
      "select status, session_token from public.client_hub_verify_code($1, $2, $3, '198.51.100.51')",
      [asked.body.data.challengeId, address, code],
    );
    expect(rows[0].status).toBe("ok");

    const global = await openTransaction({ role: "service_role" });
    const ended = await Promise.race([
      settleEnd(global.connection.query(END_SQL, [t1, true])),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
    ]);
    expect(ended).toBe("ok");
    await closeTransaction(global, "commit");
    await closeTransaction(verifying, "commit");

    expect((await me(t1)).status).toBe(401);
    expect((await me(rows[0].session_token)).status).toBe(200);
  });

  it("global logouts of two accounts do not wait for each other", async () => {
    const first = await login(email("acct-a"));
    const second = await login(email("acct-b"));
    const a = await openTransaction({ role: "service_role" });
    const b = await openTransaction({ role: "service_role" });
    expect(await settleEnd(a.connection.query(END_SQL, [first, true]))).toBe(
      "ok",
    );
    const other = await Promise.race([
      settleEnd(b.connection.query(END_SQL, [second, true])),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000)),
    ]);
    expect(other).toBe("ok");
    await closeTransaction(a, "commit");
    await closeTransaction(b, "commit");
  });

  it("a revoked or expired token waits for nothing and changes nothing, even while another global logout runs", async () => {
    const address = email("stale-global");
    const stale = await login(address);
    await logout(stale);
    const expired = await login(address);
    await db.query(
      `update private.client_hub_sessions set expires_at = now() - interval '1 second'
       where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
      [expired],
    );
    const live = await login(address);
    for (const token of [stale, expired]) {
      expect(await settleEnd(db.query(END_SQL, [token, true]))).toBe("ok");
    }
    expect((await me(live)).status).toBe(200);
  });
});
