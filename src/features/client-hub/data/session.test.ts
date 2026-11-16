import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PRESENTED_SESSIONS,
  clearedSessionCookie,
  presentedSessions,
  sessionCookie,
  sessionCookieName,
} from "./session";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const T1 = "a".repeat(64);
const T2 = "b".repeat(64);

function withCookie(cookie: string) {
  return new Request("http://localhost/api/client-hub/me", {
    headers: { cookie },
  });
}

describe("presented session cookies", () => {
  it("one pair per well-formed cookie, named after its session", () => {
    expect(
      presentedSessions(
        withCookie(
          `a=b; __Host-client_hub_s_${S1}=${T1}; theme=dark; __Host-client_hub_s_${S2}=${T2}`,
        ),
      ),
    ).toEqual({
      names: [`__Host-client_hub_s_${S1}`, `__Host-client_hub_s_${S2}`],
      sessions: [S1, S2],
      tokens: [T1, T2],
      excessive: false,
    });
    expect(presentedSessions(new Request("http://localhost/"))).toEqual({
      names: [],
      sessions: [],
      tokens: [],
      excessive: false,
    });
  });

  it("names that are not exactly ours are ignored: never examined, deleted or counted", () => {
    for (const cookie of [
      `client_hub_session=${T1}`, // the former single cookie
      `client_hub_s_${S1}=${T1}`, // the former per-session name (no prefix)
      `__host-client_hub_s_${S1}=${T1}`, // prefix in another case
      `__Secure-client_hub_s_${S1}=${T1}`, // a prefix that allows Domain=
      `%5F%5FHost-client_hub_s_${S1}=${T1}`, // encoded, never decoded
      `__Host-client_hub_s_ABCDEF00-1111-4111-8111-111111111111=${T1}`,
      `__Host-client_hub_s_${S1}x=${T1}`,
      `x__Host-client_hub_s_${S1}=${T1}`,
      `__Host-client_hub_s_${S1.replaceAll("-", "")}=${T1}`,
      `__Host-client_hub_s_=${T1}`,
    ]) {
      expect(presentedSessions(withCookie(cookie)).names, cookie).toEqual([]);
    }
  });

  it("any number of foreign session cookies is not counted: the browser's own session stays usable", () => {
    const planted = Array.from(
      { length: 40 },
      (_, i) =>
        `client_hub_s_${String(i).padStart(8, "0")}-1111-4111-8111-111111111111=${T2}`,
    );
    expect(
      presentedSessions(
        withCookie([...planted, `__Host-client_hub_s_${S1}=${T1}`].join("; ")),
      ),
    ).toEqual({
      names: [`__Host-client_hub_s_${S1}`],
      sessions: [S1],
      tokens: [T1],
      excessive: false,
    });
  });

  it("a malformed value is no token, but its name is kept (to delete it)", () => {
    for (const value of [`${T1}x`, "../etc", "", T1.toUpperCase()]) {
      expect(
        presentedSessions(withCookie(`__Host-client_hub_s_${S1}=${value}`)),
      ).toEqual({
        names: [`__Host-client_hub_s_${S1}`],
        sessions: [],
        tokens: [],
        excessive: false,
      });
    }
  });

  it("a name presented twice: each value is examined, the name kept once; identical values once", () => {
    expect(
      presentedSessions(
        withCookie(
          `__Host-client_hub_s_${S1}=${T2}; __Host-client_hub_s_${S1}=${T1}; __Host-client_hub_s_${S1}=${T1}`,
        ),
      ),
    ).toEqual({
      names: [`__Host-client_hub_s_${S1}`],
      sessions: [S1, S1],
      tokens: [T2, T1],
      excessive: false,
    });
  });

  it("more cookies than allowed: none is examined (fail closed), all are to be deleted", () => {
    const ids = Array.from(
      { length: MAX_PRESENTED_SESSIONS + 1 },
      (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    const many = presentedSessions(
      withCookie(ids.map((id) => `__Host-client_hub_s_${id}=${T1}`).join("; ")),
    );
    expect(many.excessive).toBe(true);
    expect(many.sessions).toEqual([]);
    expect(many.names).toHaveLength(MAX_PRESENTED_SESSIONS + 1);

    const exactly = presentedSessions(
      withCookie(
        ids
          .slice(0, MAX_PRESENTED_SESSIONS)
          .map((id) => `__Host-client_hub_s_${id}=${T1}`)
          .join("; "),
      ),
    );
    expect(exactly.excessive).toBe(false);
    expect(exactly.sessions).toHaveLength(MAX_PRESENTED_SESSIONS);

    // Many values under fewer names count too.
    const values = presentedSessions(
      withCookie(
        Array.from(
          { length: MAX_PRESENTED_SESSIONS + 1 },
          (_, i) =>
            `__Host-client_hub_s_${S1}=${i.toString(16).padStart(64, "0")}`,
        ).join("; "),
      ),
    );
    expect(values.excessive).toBe(true);
    expect(values.sessions).toEqual([]);
  });
});

describe("session cookie attributes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("what the __Host- prefix requires: Secure, Path=/, no Domain; plus HttpOnly, SameSite=Lax, expiring with the session", () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const cookie = sessionCookie(S1, T1, expiresAt);
    expect(cookie).toMatch(new RegExp(`^__Host-client_hub_s_${S1}=${T1}; `));
    expect(cookie.split("; ").slice(1, 5)).toEqual([
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Secure",
    ]);
    expect(cookie).not.toMatch(/Domain/i);
    expect(Number(cookie.match(/Max-Age=(\d+)/)![1])).toBeGreaterThan(3590);
    expect(clearedSessionCookie(sessionCookieName(S1))).toBe(
      `__Host-client_hub_s_${S1}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
    );
  });

  it("Secure in every environment (a __Host- cookie without it is refused by the browser)", () => {
    for (const environment of ["development", "test", "production"]) {
      vi.stubEnv("NODE_ENV", environment);
      expect(sessionCookie(S1, T1, new Date().toISOString())).toContain(
        "; Secure;",
      );
      expect(clearedSessionCookie(sessionCookieName(S1))).toContain(
        "; Secure;",
      );
    }
  });

  it("never issues a malformed cookie", () => {
    const at = new Date().toISOString();
    expect(() => sessionCookie("not-a-uuid", T1, at)).toThrow();
    expect(() => sessionCookie(S1, "short", at)).toThrow();
  });
});
