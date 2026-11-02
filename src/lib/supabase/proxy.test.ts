import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { refreshSupabaseSession, requiresSession } from "./proxy";

describe("requiresSession", () => {
  it.each([
    ["/app", true],
    ["/app/services", true],
    ["/onboarding", true],
    ["/onboarding/step", true],
    ["/applications", false],
    ["/b/studio-mila", false],
    ["/login", false],
    ["/api/bookings", false],
    ["/api/public/businesses/studio", false],
    ["/auth/callback", false],
    ["/", false],
  ])("%s → %s", (pathname, expected) => {
    expect(requiresSession(pathname)).toBe(expected);
  });
});

describe("refreshSupabaseSession without a session cookie", () => {
  const saved = { ...process.env };

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  });

  afterAll(() => {
    process.env = saved;
  });

  it.each(["/app", "/app/settings", "/onboarding"])(
    "redirects %s to /login",
    async (pathname) => {
      const response = await refreshSupabaseSession(
        new NextRequest(`http://localhost:3000${pathname}`),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/login",
      );
    },
  );

  it.each([
    "/b/studio-mila",
    "/login",
    "/",
    "/api/public/businesses/studio-mila",
  ])("lets the public route %s through", async (pathname) => {
    const response = await refreshSupabaseSession(
      new NextRequest(`http://localhost:3000${pathname}`),
    );

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("refreshSupabaseSession when Auth fails (expired session, refresh attempted)", () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;

  /** A session cookie whose access token has expired: a refresh is due. */
  function expiredSessionCookie() {
    const jwt = (payload: object) =>
      [{ alg: "HS256", typ: "JWT" }, payload]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .concat("signature")
        .join(".");
    const past = Math.floor(Date.now() / 1000) - 3600;
    const session = {
      access_token: jwt({ sub: "user-1", exp: past, role: "authenticated" }),
      refresh_token: "refresh-token-1",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: past,
      user: { id: "user-1", aud: "authenticated", role: "authenticated" },
    };
    return `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
  }

  function deletedSessionCookies(response: Response) {
    return response.headers
      .getSetCookie()
      .filter((line) => line.startsWith("sb-"))
      .filter((line) => /^sb-[^=]+=;/.test(line) || /max-age=0/i.test(line));
  }

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    process.env = saved;
    globalThis.fetch = realFetch;
  });

  it.each([
    [
      "no answer (network)",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "an answer Auth-js cannot read (AuthUnknownError: it deletes the session itself)",
      async () => new Response("I'm a teapot", { status: 418 }),
    ],
    [
      "a 503 from the gateway",
      async () =>
        new Response(JSON.stringify({ message: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    ],
  ])(
    "%s: no redirect to /login, no session cookie deleted",
    async (_label, answer) => {
      globalThis.fetch = answer as typeof fetch;
      // Auth-js retries a refresh that failed for a retryable reason, with
      // a backoff bounded by 30 s: the clock is driven, not waited for.
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      const pending = refreshSupabaseSession(
        new NextRequest("http://localhost:3000/app", {
          headers: { cookie: expiredSessionCookie() },
        }),
      );
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.headers.get("location")).toBeNull();
      expect(deletedSessionCookies(response)).toEqual([]);
      // What the guards and actions read next: her session cookie, intact.
      expect(response.headers.get("x-middleware-request-cookie")).toContain(
        expiredSessionCookie().split("=")[0] + "=base64-",
      );
    },
  );

  it("a refresh token Auth refuses (400): a real sign-out, /login, cookies cleared", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "refresh_token_not_found",
          msg: "Invalid Refresh Token",
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
            "x-supabase-api-version": "2024-01-01",
          },
        },
      )) as typeof fetch;
    const response = await refreshSupabaseSession(
      new NextRequest("http://localhost:3000/app", {
        headers: { cookie: expiredSessionCookie() },
      }),
    );
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login",
    );
    expect(deletedSessionCookies(response).length).toBeGreaterThan(0);
  });
});
