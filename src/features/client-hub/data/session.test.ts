import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_HUB_COOKIE,
  clearedSessionCookie,
  sessionCookie,
  sessionTokenOf,
} from "./session";

const TOKEN = "a".repeat(64);

function withCookie(cookie: string) {
  return new Request("http://localhost/api/client-hub/me", {
    headers: { cookie },
  });
}

describe("session cookie", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads only a well-formed token from its own cookie", () => {
    expect(
      sessionTokenOf(withCookie(`a=b; ${CLIENT_HUB_COOKIE}=${TOKEN}`)),
    ).toBe(TOKEN);
    expect(
      sessionTokenOf(withCookie(`${CLIENT_HUB_COOKIE}=${TOKEN}x`)),
    ).toBeNull();
    expect(
      sessionTokenOf(withCookie(`${CLIENT_HUB_COOKIE}=../etc`)),
    ).toBeNull();
    expect(
      sessionTokenOf(withCookie(`x_${CLIENT_HUB_COOKIE}=${TOKEN}`)),
    ).toBeNull();
    expect(sessionTokenOf(new Request("http://localhost/"))).toBeNull();
  });

  it("is HttpOnly, SameSite=Lax, scoped to the hub API, and expires with the session", () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const cookie = sessionCookie(TOKEN, expiresAt);
    expect(cookie).toMatch(new RegExp(`^${CLIENT_HUB_COOKIE}=${TOKEN}; `));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/client-hub");
    expect(Number(cookie.match(/Max-Age=(\d+)/)![1])).toBeGreaterThan(3590);
    expect(cookie).not.toContain("Secure");
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("is Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie(TOKEN, new Date().toISOString())).toContain("Secure");
    expect(clearedSessionCookie()).toContain("Secure");
  });
});
