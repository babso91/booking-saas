import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  requireReadyBusiness,
  currentSessionState,
} from "@/features/auth/data/guards";
import { signOutAction } from "@/features/auth/actions/auth";
import { getSessionState } from "@/features/auth/data/session";
import { getMyPreferencesAction } from "@/features/preferences/actions/preferences";
import { AppException } from "@/lib/errors";
import { refreshSupabaseSession } from "@/lib/supabase/proxy";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";

import { createBusiness, env } from "./support/fixtures";

// Supabase Auth unreachable is not a sign-out. Against the local stack:
//   * transport failure: the app's Supabase URL points to a closed port;
//   * the Auth service down (its container stopped), PostgREST still up:
//     the gateway answers 500, which auth-js reports as retryable.
// Then, for each: the proxy does not send the visitor to /login nor delete
// her session cookies; the guards send her to /indisponible; Server Actions
// answer `auth_unavailable`; and once Auth is back, the same cookies work.
// A session really absent, revoked or forged is still refused as before.

class Device {
  readonly cookies = new Map<string, string>();

  getAll() {
    return [...this.cookies].map(([name, value]) => ({ name, value }));
  }

  get(name: string) {
    const value = this.cookies.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options?: { maxAge?: number }) {
    if (!value || options?.maxAge === 0) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  header() {
    return this.getAll()
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
  }
}

let device = new Device();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => device.getAll(),
    get: (name: string) => device.get(name),
    set: (name: string, value: string, options?: { maxAge?: number }) =>
      device.set(name, value, options),
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Account = { userId: string; email: string; password: string };

async function createAccount(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("user");
  return { userId: data.user.id, email, password };
}

async function signInHere(account: Account) {
  const client = await createServerSupabaseClient();
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) throw error;
}

const AUTH_CONTAINER = "supabase_auth_booking-saas";

async function authHealthy() {
  try {
    const response = await fetch(`${env.apiUrl}/auth/v1/health`, {
      headers: { apikey: env.anonKey },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Auth answers a 5xx quickly (within a second): the gateway knows it is down. */
async function authAnswersError() {
  try {
    const response = await fetch(`${env.apiUrl}/auth/v1/health`, {
      headers: { apikey: env.anonKey },
      signal: AbortSignal.timeout(1000),
    });
    return response.status >= 500;
  } catch {
    return false;
  }
}

const outages = {
  "transport failure (no answer)": {
    start: async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    },
    stop: async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
    },
  },
  "the Auth service down (gateway 500), the database up": {
    start: async () => {
      execFileSync("docker", ["stop", AUTH_CONTAINER], { stdio: "ignore" });
      // The gateway first waits for the stopped upstream, then answers 5xx
      // at once: wait for that (bounded), not for an arbitrary delay.
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await authAnswersError()) return;
      }
      throw new Error("the gateway never reported Auth down");
    },
    stop: async () => {
      execFileSync("docker", ["start", AUTH_CONTAINER], { stdio: "ignore" });
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await authHealthy()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Auth did not come back");
    },
  },
} as const;

/** The proxy, as Next runs it for a request carrying this device's cookies. */
function proxy(path: string, method = "GET") {
  return refreshSupabaseSession(
    new NextRequest(`http://localhost:3000${path}`, {
      method,
      headers: device.cookies.size > 0 ? { cookie: device.header() } : {},
    }),
  );
}

/** Session cookies the response deletes (empty value or expired). */
function deletedSessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((line) => line.startsWith("sb-"))
    .filter(
      (line) =>
        /^sb-[^=]+=;/.test(line) ||
        /max-age=0/i.test(line) ||
        /expires=thu, 01 jan 1970/i.test(line),
    );
}

/** The path a redirect() thrown by a guard goes to, if any. */
async function redirectOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2] ?? null;
    }
    throw error;
  }
}

let izabela: Account;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  izabela = await createAccount("outage");
  await createBusiness(izabela.userId);
});

afterEach(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  if (!(await authHealthy()))
    await outages[
      "the Auth service down (gateway 500), the database up"
    ].stop();
});

describe.each(Object.entries(outages))(
  "Auth unreachable: %s",
  (_label, outage) => {
    it("is not a sign-out: no redirect to /login, no cookie deleted, a distinct error; the same session works once Auth is back", async () => {
      device = new Device();
      await signInHere(izabela);
      const cookiesBefore = new Map(device.cookies);
      expect(
        [...cookiesBefore.keys()].some((name) => name.startsWith("sb-")),
      ).toBe(true);

      await outage.start();
      try {
        // The proxy lets the request reach the guards; it deletes nothing.
        for (const [path, method] of [
          ["/app", "GET"],
          ["/app/clients", "GET"],
          ["/onboarding", "GET"],
          ["/app", "POST"],
        ] as const) {
          const response = await proxy(path, method);
          expect(response.headers.get("location")).toBeNull();
          expect(deletedSessionCookies(response)).toEqual([]);
        }

        // The session state is an error, not "unauthenticated".
        const client = await createServerSupabaseClient();
        await expect(getSessionState(client)).rejects.toMatchObject({
          code: "auth_unavailable",
        });

        // The guards send her to a temporary error page, not to /login.
        expect(await redirectOf(() => requireReadyBusiness())).toBe(
          "/indisponible",
        );

        // A Server Action answers a structured, temporary error.
        expect(await getMyPreferencesAction()).toMatchObject({
          ok: false,
          error: { code: "auth_unavailable" },
        });

        // Her cookies are untouched.
        expect(device.cookies).toEqual(cookiesBefore);
      } finally {
        await outage.stop();
      }

      // Auth is back: the very same session.
      expect(await redirectOf(() => requireReadyBusiness())).toBeNull();
      expect((await getMyPreferencesAction()).ok).toBe(true);
      const response = await proxy("/app");
      expect(response.headers.get("location")).toBeNull();
    });
  },
);

describe("a session really absent, revoked or forged is still refused", () => {
  it("no session cookie: /login, unauthenticated", async () => {
    device = new Device();
    const response = await proxy("/app");
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );
    const client = await createServerSupabaseClient();
    expect(await getSessionState(client)).toEqual({
      status: "unauthenticated",
    });
    expect(await redirectOf(() => requireReadyBusiness())).toBe("/login");
    expect(await getMyPreferencesAction()).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
  });

  it("a session revoked elsewhere (signed out everywhere): /login, unauthenticated", async () => {
    device = new Device();
    await signInHere(izabela);
    const revoked = new Map(device.cookies);
    // She signs out everywhere from another device.
    const other = createClient<Database>(env.apiUrl, env.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await other.auth.signInWithPassword({
      email: izabela.email,
      password: izabela.password,
    });
    await other.auth.signOut({ scope: "global" });

    device = new Device();
    for (const [name, value] of revoked) device.set(name, value);
    // The proxy is optimistic (it checks the JWT's signature, which a
    // revoked session still has); the guards and actions ask Auth.
    const response = await proxy("/app");
    expect(deletedSessionCookies(response)).toEqual([]);
    expect(await redirectOf(() => requireReadyBusiness())).toBe("/login");
    const client = await createServerSupabaseClient();
    expect(await getSessionState(client)).toEqual({
      status: "unauthenticated",
    });
    expect(await getMyPreferencesAction()).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
  });

  it("a forged access token: /login, unauthenticated", async () => {
    device = new Device();
    await signInHere(izabela);
    for (const [name, value] of device.cookies) {
      if (!name.startsWith("sb-")) continue;
      const raw = value.startsWith("base64-")
        ? Buffer.from(value.slice(7), "base64").toString("utf8")
        : value;
      const session = JSON.parse(raw);
      const [header, payload] = session.access_token.split(".");
      session.access_token = `${header}.${payload}.${"A".repeat(43)}`;
      device.set(
        name,
        `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`,
      );
    }
    const response = await proxy("/app");
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );
    const client = await createServerSupabaseClient();
    expect(await getSessionState(client)).toEqual({
      status: "unauthenticated",
    });
  });
});

describe("the error is typed", () => {
  it("auth_unavailable is an AppException with its own code and HTTP status", async () => {
    device = new Device();
    await signInHere(izabela);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    const client = await createServerSupabaseClient();
    const error = await getSessionState(client).catch((caught) => caught);
    expect(error).toBeInstanceOf(AppException);
    expect(error.code).toBe("auth_unavailable");
    await expect(currentSessionState()).rejects.toMatchObject({
      code: "auth_unavailable",
    });
  });
});

// The access token has expired and Auth answers something it cannot read
// (an HTML 403 or 418 from a proxy, a firewall…): auth-js reports
// AuthUnknownError, which it does not retry, and removes the session. Under
// a Server Action, that removal reaches the cookie store before the action
// answers `auth_unavailable`: the refresh token was lost to an outage.
// A local gateway forwards everything to the stack, except Auth when told
// to answer that way.

type Gateway = { url: string; authAnswer: number | null; close(): void };

async function startGateway(): Promise<Gateway> {
  const gateway = { authAnswer: null as number | null };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (gateway.authAnswer !== null && request.url!.startsWith("/auth/v1/")) {
      response.writeHead(gateway.authAnswer, { "content-type": "text/html" });
      response.end("<html><body>Service unavailable</body></html>");
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (["host", "connection", "content-length"].includes(name)) continue;
      if (typeof value === "string") headers.set(name, value);
    }
    const upstream = await fetch(`${env.apiUrl}${request.url}`, {
      method: request.method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (
        !["content-encoding", "content-length", "transfer-encoding"].includes(
          name,
        )
      ) {
        out[name] = value;
      }
    });
    response.writeHead(upstream.status, out);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as { port: number };
  return Object.assign(gateway, {
    // Same host as the stack (127.0.0.1): same session cookie name.
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  });
}

/** Her session as this device stores it (chunked or not). */
function storedSession() {
  const names = [...device.cookies.keys()]
    .filter((name) => /^sb-[^.]+-auth-token(\.\d+)?$/.test(name))
    .sort();
  const value = names.map((name) => device.cookies.get(name)!).join("");
  if (!value) return null;
  const raw = value.startsWith("base64-")
    ? Buffer.from(value.slice(7), "base64url").toString("utf8")
    : value;
  return { names, session: JSON.parse(raw) };
}

/** The access token expires now; the refresh token is untouched. */
function expireAccessToken() {
  const stored = storedSession()!;
  stored.session.expires_at = Math.floor(Date.now() / 1000) - 60;
  const key = stored.names[0]!.replace(/\.\d+$/, "");
  for (const name of stored.names) device.cookies.delete(name);
  device.set(
    key,
    `base64-${Buffer.from(JSON.stringify(stored.session)).toString("base64url")}`,
  );
}

function sessionIdOf(accessToken: string) {
  const payload = JSON.parse(
    Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8"),
  );
  return payload.session_id as string;
}

function sessionCookies() {
  return new Map(
    [...device.cookies].filter(([name]) => name.startsWith("sb-")),
  );
}

describe("an unreadable answer from Auth with an expired access token, under a Server Action", () => {
  let gateway: Gateway;

  beforeAll(async () => {
    gateway = await startGateway();
  });

  afterEach(() => {
    gateway.authAnswer = null;
  });

  it.each([403, 418])(
    "HTTP %i: auth_unavailable, the refresh token is kept, and the same session resumes once Auth answers",
    async (status) => {
      device = new Device();
      await signInHere(izabela);
      const sessionId = sessionIdOf(storedSession()!.session.access_token);
      expireAccessToken();
      const before = sessionCookies();

      process.env.NEXT_PUBLIC_SUPABASE_URL = gateway.url;
      gateway.authAnswer = status;

      expect(await getMyPreferencesAction()).toMatchObject({
        ok: false,
        error: { code: "auth_unavailable" },
      });
      expect(sessionCookies()).toEqual(before);
      expect(await redirectOf(() => requireReadyBusiness())).toBe(
        "/indisponible",
      );
      expect(sessionCookies()).toEqual(before);

      // Auth answers again: the same session, refreshed.
      gateway.authAnswer = null;
      expect((await getMyPreferencesAction()).ok).toBe(true);
      const after = storedSession()!.session;
      expect(sessionIdOf(after.access_token)).toBe(sessionId);
      expect(after.expires_at * 1000).toBeGreaterThan(Date.now());
    },
  );

  it("a refresh token Auth really refuses (revoked) is still removed: unauthenticated", async () => {
    device = new Device();
    await signInHere(izabela);
    const other = createClient<Database>(env.apiUrl, env.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await other.auth.signInWithPassword({
      email: izabela.email,
      password: izabela.password,
    });
    await other.auth.signOut({ scope: "global" });
    expireAccessToken();

    process.env.NEXT_PUBLIC_SUPABASE_URL = gateway.url;
    expect(await getMyPreferencesAction()).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(sessionCookies().size).toBe(0);
  });

  it("a session revoked elsewhere, access token still valid: removed, unauthenticated", async () => {
    device = new Device();
    await signInHere(izabela);
    const other = createClient<Database>(env.apiUrl, env.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await other.auth.signInWithPassword({
      email: izabela.email,
      password: izabela.password,
    });
    await other.auth.signOut({ scope: "global" });

    expect(await getMyPreferencesAction()).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(sessionCookies().size).toBe(0);
  });
});

describe("signing out on purpose always forgets the session on this device", () => {
  let gateway: Gateway;

  beforeAll(async () => {
    gateway = await startGateway();
  });

  afterEach(() => {
    gateway.authAnswer = null;
  });

  async function refreshWorks(refreshToken: string) {
    const client = createClient<Database>(env.apiUrl, env.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await client.auth.refreshSession({
      refresh_token: refreshToken,
    });
    return error === null;
  }

  it("Auth up: the session is revoked and its cookies deleted", async () => {
    device = new Device();
    await signInHere(izabela);
    const refreshToken = storedSession()!.session.refresh_token;

    expect(await signOutAction()).toEqual({
      ok: true,
      data: { next: "/login" },
    });
    expect(sessionCookies().size).toBe(0);
    expect(await refreshWorks(refreshToken)).toBe(false);
    expect(await redirectOf(() => requireReadyBusiness())).toBe("/login");
  });

  it.each([
    ["an unreadable 418, access token valid", 418, false],
    ["an unreadable 403, access token expired", 403, true],
    ["a 503, access token valid", 503, false],
    // auth-js retries a 5xx refresh for up to 30 s, then gives up without
    // removing anything: the slow case, the one only an explicit deletion
    // covers.
    ["a 503, access token expired", 503, true],
  ] as const)(
    "Auth unreachable (%s): her cookies are deleted all the same",
    async (_label, status, expired) => {
      device = new Device();
      await signInHere(izabela);
      if (expired) expireAccessToken();

      process.env.NEXT_PUBLIC_SUPABASE_URL = gateway.url;
      gateway.authAnswer = status;
      expect(await signOutAction()).toEqual({
        ok: true,
        data: { next: "/login" },
      });
      expect(sessionCookies().size).toBe(0);

      gateway.authAnswer = null;
      expect(await redirectOf(() => requireReadyBusiness())).toBe("/login");
    },
    60_000,
  );
});
