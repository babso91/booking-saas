import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppException } from "@/lib/errors";

import { CookieJar } from "../../../../tests/support/cookie-jar";

// The real Client Hub route handlers and their cookie policy, with a
// browser cookie jar applying their Set-Cookie headers. The database is
// replaced (it says which presented session wins, or that none does); the
// database tests and the Chromium tests cover the same with real sessions.

const data = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  getProfile: vi.fn(),
  listAppointments: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/features/client-hub/data/client-hub", () => data);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({}),
}));

import { GET as getAppointments } from "@/app/api/client-hub/businesses/[businessId]/appointments/route";
import { GET as getMe } from "@/app/api/client-hub/me/route";
import { DELETE as deleteSession } from "@/app/api/client-hub/session/route";

import { MAX_PRESENTED_SESSIONS, sessionCookie } from "./session";

const SA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A = "a".repeat(64);
const B = "b".repeat(64);
const ACCOUNT_B = "0000000b-0000-4000-8000-000000000000";
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const nameOf = (session: string) => `client_hub_s_${session}`;

function from(jar: CookieJar, method: string, path: string) {
  const headers = new Headers();
  const cookie = jar.header(path);
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    headers,
  });
}

const deleted = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((line) => /Max-Age=0/.test(line))
    .map((line) => line.slice(0, line.indexOf("=")))
    .sort();

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  for (const mock of Object.values(data)) mock.mockReset();
  data.signOut.mockResolvedValue(undefined);
});

describe("answers only ever add or delete their own sessions' cookies", () => {
  it("a late 401 of A's read, arriving after B signed in, deletes A's cookie only: B stays", async () => {
    const jar = new CookieJar();
    jar.set(sessionCookie(SA, A, inAWeek()));

    // A's read leaves now; its answer (no live session) comes late.
    let answer!: (value: unknown) => void;
    data.resolveSession.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const lateRead = getMe(from(jar, "GET", "/api/client-hub/me"));

    // Meanwhile B signs in: the verify answer deletes A's, adds B's.
    jar.set(`${nameOf(SA)}=; Path=/api/client-hub; Max-Age=0`);
    jar.set(sessionCookie(SB, B, inAWeek()));

    answer({ status: "none" });
    const late = await lateRead;
    expect(late.status).toBe(401);
    expect(deleted(late)).toEqual([nameOf(SA)]);
    jar.apply(late);
    expect(jar.get(nameOf(SB))?.value).toBe(B);

    data.resolveSession.mockResolvedValueOnce({
      status: "ok",
      sessionId: SB,
      token: B,
      accountId: ACCOUNT_B,
    });
    data.getProfile.mockResolvedValueOnce({ email: "b@x.fr", businesses: [] });
    const next = await getMe(from(jar, "GET", "/api/client-hub/me"));
    expect(next.status).toBe(200);
    expect(data.resolveSession).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ sessions: [SB], tokens: [B] }),
    );
    expect(data.getProfile).toHaveBeenLastCalledWith({}, B);
    expect(next.headers.get("x-client-hub-account")).toBe(ACCOUNT_B);
  });

  it("a late sign-out of A, arriving after B signed in, ends and deletes A only", async () => {
    const jar = new CookieJar();
    jar.set(sessionCookie(SA, A, inAWeek()));
    const out = await deleteSession(
      from(jar, "DELETE", "/api/client-hub/session"),
    );
    expect(data.signOut).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sessions: [SA], tokens: [A] }),
      false,
    );
    jar.set(sessionCookie(SB, B, inAWeek()));
    jar.apply(out);
    expect(jar.get(nameOf(SA))).toBeNull();
    expect(jar.get(nameOf(SB))?.value).toBe(B);
  });

  it("the winner is read and kept; the others presented are deleted; the answer names its account", async () => {
    const jar = new CookieJar();
    jar.set(sessionCookie(SA, A, inAWeek()));
    jar.set(sessionCookie(SB, B, inAWeek()));
    data.resolveSession.mockResolvedValue({
      status: "ok",
      sessionId: SB,
      token: B,
      accountId: ACCOUNT_B,
    });
    data.getProfile.mockResolvedValue({ email: "b@x.fr", businesses: [] });
    const response = await getMe(from(jar, "GET", "/api/client-hub/me"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-client-hub-account")).toBe(ACCOUNT_B);
    expect(deleted(response)).toEqual([nameOf(SA)]);
    expect(response.headers.getSetCookie()).toHaveLength(1);

    // A refusal by the read itself (a 404): same account named, same deletions.
    data.listAppointments.mockRejectedValue(
      new AppException("client_hub_not_found"),
    );
    const missing = await getAppointments(
      from(
        jar,
        "GET",
        `/api/client-hub/businesses/${BUSINESS}/appointments?scope=upcoming`,
      ),
      { params: Promise.resolve({ businessId: BUSINESS }) } as never,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-client-hub-account")).toBe(ACCOUNT_B);
    expect(deleted(missing)).toEqual([nameOf(SA)]);
  });

  it("no live session, or a conflict between accounts: 401 naming nobody, every presented cookie deleted", async () => {
    for (const status of ["none", "conflict"]) {
      data.resolveSession.mockResolvedValueOnce({ status });
      const jar = new CookieJar();
      jar.set(sessionCookie(SA, A, inAWeek()));
      jar.set(sessionCookie(SB, B, inAWeek()));
      const response = await getMe(from(jar, "GET", "/api/client-hub/me"));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "client_hub_unauthenticated" },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-client-hub-account")).toBeNull();
      expect(deleted(response)).toEqual([nameOf(SA), nameOf(SB)].sort());
    }
  });

  it("the session ended between the resolution and the read: 401, its cookie deleted too, nobody named", async () => {
    data.resolveSession.mockResolvedValue({
      status: "ok",
      sessionId: SA,
      token: A,
      accountId: ACCOUNT_B,
    });
    data.getProfile.mockRejectedValue(
      new AppException("client_hub_unauthenticated"),
    );
    const jar = new CookieJar();
    jar.set(sessionCookie(SA, A, inAWeek()));
    const response = await getMe(from(jar, "GET", "/api/client-hub/me"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-client-hub-account")).toBeNull();
    expect(deleted(response)).toEqual([nameOf(SA)]);
  });

  it("the database could not say: 500, and no cookie is touched", async () => {
    data.resolveSession.mockRejectedValue(new Error("connection reset"));
    const jar = new CookieJar();
    jar.set(sessionCookie(SA, A, inAWeek()));
    const response = await getMe(from(jar, "GET", "/api/client-hub/me"));
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-client-hub-account")).toBeNull();
  });

  it("without any session cookie: 401 without asking the database, without Set-Cookie", async () => {
    const response = await getMe(
      from(new CookieJar(), "GET", "/api/client-hub/me"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(data.resolveSession).not.toHaveBeenCalled();
  });

  it("only malformed values under our names: 401 without the database, those names deleted", async () => {
    const request = new NextRequest("http://localhost:3000/api/client-hub/me", {
      headers: { cookie: `${nameOf(SA)}=nope; client_hub_s_bad=${A}` },
    });
    const response = await getMe(request);
    expect(response.status).toBe(401);
    expect(deleted(response)).toEqual([nameOf(SA)]);
    expect(data.resolveSession).not.toHaveBeenCalled();
  });

  it("more session cookies than allowed: refused without the database (no session chosen), all deleted; a sign-out ends none of them", async () => {
    const ids = Array.from(
      { length: MAX_PRESENTED_SESSIONS + 1 },
      (_, i) => `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const cookie = ids.map((id) => `${nameOf(id)}=${A}`).join("; ");
    const read = await getMe(
      new NextRequest("http://localhost:3000/api/client-hub/me", {
        headers: { cookie },
      }),
    );
    expect(read.status).toBe(401);
    expect(deleted(read)).toHaveLength(ids.length);
    expect(data.resolveSession).not.toHaveBeenCalled();

    const out = await deleteSession(
      new NextRequest("http://localhost:3000/api/client-hub/session", {
        method: "DELETE",
        headers: { cookie },
      }),
    );
    expect(out.status).toBe(200);
    expect(deleted(out)).toHaveLength(ids.length);
    expect(data.signOut).not.toHaveBeenCalled();
  });

  it("the session cookies stay out of reach of scripts and of every other path", () => {
    const cookie = sessionCookie(SB, B, inAWeek());
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/client-hub/);
    const jar = new CookieJar();
    jar.set(cookie);
    expect(jar.header("/espace")).toBe("");
    expect(jar.header("/api/client-hub/me")).toBe(`${nameOf(SB)}=${B}`);
  });
});
