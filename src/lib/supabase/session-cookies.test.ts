import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authOutageGuard,
  deletesCookie,
  isSessionCookie,
} from "@/lib/supabase/session-cookies";

const AUTH = "http://127.0.0.1:54321/auth/v1/token?grant_type=refresh_token";
const REST = "http://127.0.0.1:54321/rest/v1/rpc/read_member_preferences";

const refresh = { name: "sb-127-auth-token", value: "base64-new", options: {} };
const deletion = {
  name: "sb-127-auth-token",
  value: "",
  options: { maxAge: 0 },
};
const chunkDeletion = {
  name: "sb-127-auth-token.1",
  value: "",
  options: { maxAge: 0 },
};

function answer(status: number, body: string, type = "application/json") {
  return new Response(status === 204 ? null : body, {
    status,
    headers: { "content-type": type },
  });
}

/** The guard after one exchange with `url` that ends with `outcome`. */
async function after(outcome: Response | Error, url = AUTH) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  );
  const guard = authOutageGuard();
  await guard.fetch(url).catch(() => undefined);
  return guard;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deletions are dropped while Auth is unreachable", () => {
  it.each([
    ["no answer (transport failure)", new TypeError("fetch failed")],
    ["a 500", answer(500, "{}")],
    ["a 503 in HTML", answer(503, "<html/>", "text/html")],
    ["a 429", answer(429, '{"code":"over_request_rate_limit"}')],
    ["an unreadable 403", answer(403, "<html>Forbidden</html>", "text/html")],
    ["an unreadable 418", answer(418, "I'm a teapot", "text/plain")],
    ["an unreadable 400", answer(400, "<html/>", "text/html")],
  ])("%s", async (_label, outcome) => {
    const guard = await after(outcome);
    expect(guard.filter([deletion, chunkDeletion])).toEqual([]);
    // A session it could write is never dropped.
    expect(guard.filter([refresh, deletion])).toEqual([refresh]);
  });
});

describe("deletions are applied when Auth answered", () => {
  it.each([
    [
      "a refused refresh token (400 JSON)",
      answer(400, '{"code":"refresh_token_not_found"}'),
    ],
    [
      "a revoked session (403 JSON)",
      answer(403, '{"code":"session_not_found"}'),
    ],
    ["an invalid JWT (401 JSON)", answer(401, '{"code":"bad_jwt"}')],
    ["a successful sign-out (204)", answer(204, "")],
    ["a 200", answer(200, '{"access_token":"…"}')],
  ])("%s", async (_label, outcome) => {
    const guard = await after(outcome);
    expect(guard.filter([deletion, chunkDeletion])).toEqual([
      deletion,
      chunkDeletion,
    ]);
  });

  it("no exchange with Auth at all (a cookie auth-js could not parse)", () => {
    expect(authOutageGuard().filter([deletion])).toEqual([deletion]);
  });
});

describe("only Auth's exchanges count", () => {
  it("a database outage does not hold an Auth deletion", async () => {
    const guard = await after(new TypeError("fetch failed"), REST);
    expect(guard.filter([deletion])).toEqual([deletion]);
  });

  it("the last Auth exchange decides: Auth back, then a refusal", async () => {
    const outcomes = [
      answer(418, "teapot", "text/plain"),
      answer(400, '{"code":"refresh_token_not_found"}'),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => outcomes.shift()!),
    );
    const guard = authOutageGuard();
    await guard.fetch(AUTH);
    expect(guard.filter([deletion])).toEqual([]);
    await guard.fetch(AUTH);
    expect(guard.filter([deletion])).toEqual([deletion]);
  });

  it("the response reaches auth-js unread", async () => {
    const guard = await after(answer(400, '{"code":"x"}'));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(400, '{"code":"y"}')),
    );
    const response = await guard.fetch(AUTH);
    expect(await response.json()).toEqual({ code: "y" });
    expect(guard.filter([deletion])).toEqual([deletion]);
  });
});

describe("helpers", () => {
  it("deletesCookie", () => {
    expect(deletesCookie(deletion)).toBe(true);
    expect(deletesCookie({ name: "a", value: "" })).toBe(true);
    expect(deletesCookie(refresh)).toBe(false);
  });

  it("isSessionCookie: the session, its chunks and the PKCE verifier only", () => {
    const url = "https://abcdefgh.supabase.co";
    for (const name of [
      "sb-abcdefgh-auth-token",
      "sb-abcdefgh-auth-token.0",
      "sb-abcdefgh-auth-token.12",
      "sb-abcdefgh-auth-token-code-verifier",
    ]) {
      expect(isSessionCookie(name, url)).toBe(true);
    }
    for (const name of [
      "sb-other-auth-token",
      "dash_pref",
      "dash_appearance",
      "sb-abcdefgh-auth-tokenx",
    ]) {
      expect(isSessionCookie(name, url)).toBe(false);
    }
    expect(isSessionCookie("sb-127-auth-token", "http://127.0.0.1:54321")).toBe(
      true,
    );
  });
});
