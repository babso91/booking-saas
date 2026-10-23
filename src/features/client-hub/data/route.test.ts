import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppException } from "@/lib/errors";

import { CookieJar } from "../../../../tests/support/cookie-jar";

// The real Client Hub route handlers and session cookies, with a browser
// cookie jar applying their Set-Cookie headers. Only the database is
// replaced (it answers "unauthenticated" for an ended session, late if the
// test says so); the database tests cover the same with real sessions.

const data = vi.hoisted(() => ({
  getProfile: vi.fn(),
  listAppointments: vi.fn(),
  endSession: vi.fn(),
}));
vi.mock("@/features/client-hub/data/client-hub", () => data);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({}),
}));

import { GET as getAppointments } from "@/app/api/client-hub/businesses/[businessId]/appointments/route";
import { GET as getMe } from "@/app/api/client-hub/me/route";
import { DELETE as deleteSession } from "@/app/api/client-hub/session/route";

import { CLIENT_HUB_COOKIE, sessionCookie } from "./session";

const A = "a".repeat(64);
const B = "b".repeat(64);
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

function from(jar: CookieJar, method: string, path: string) {
  const headers = new Headers();
  const cookie = jar.header(path);
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    headers,
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  data.getProfile.mockReset();
  data.listAppointments.mockReset();
  data.endSession.mockReset().mockResolvedValue(undefined);
});

describe("refused reads never touch the session cookie", () => {
  it("a late 401 of A's read, arriving after B signed in, leaves B's cookie in place", async () => {
    const jar = new CookieJar();
    jar.set(sessionCookie(A, inAWeek()));

    // A's read leaves now; its answer (A's session has ended) comes late.
    let endA!: () => void;
    data.getProfile.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          endA = () => reject(new AppException("client_hub_unauthenticated"));
        }),
    );
    const lateRead = getMe(from(jar, "GET", "/api/client-hub/me"));

    // Meanwhile B signs in: the verify route's cookie replaces A's.
    jar.set(sessionCookie(B, inAWeek()));

    // A's 401 arrives; the browser applies its headers.
    endA();
    const late = await lateRead;
    expect(late.status).toBe(401);
    jar.apply(late);

    expect(jar.get(CLIENT_HUB_COOKIE)?.value).toBe(B);
    // B goes on reading with her own session.
    data.getProfile.mockResolvedValueOnce({
      email: "b@exemple.fr",
      businesses: [],
    });
    const next = await getMe(from(jar, "GET", "/api/client-hub/me"));
    expect(next.status).toBe(200);
    expect(data.getProfile).toHaveBeenLastCalledWith({}, B);
  });

  it("a refused GET answers 401, uncached, with no Set-Cookie at all", async () => {
    data.getProfile.mockRejectedValue(
      new AppException("client_hub_unauthenticated"),
    );
    data.listAppointments.mockRejectedValue(
      new AppException("client_hub_unauthenticated"),
    );
    const jar = new CookieJar();
    jar.set(sessionCookie(A, inAWeek()));

    const refused = [
      await getMe(from(jar, "GET", "/api/client-hub/me")),
      await getMe(from(new CookieJar(), "GET", "/api/client-hub/me")),
      await getAppointments(
        from(
          jar,
          "GET",
          `/api/client-hub/businesses/${BUSINESS}/appointments?scope=upcoming`,
        ),
        { params: Promise.resolve({ businessId: BUSINESS }) } as never,
      ),
    ];
    for (const response of refused) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).toMatchObject({
        error: { code: "client_hub_unauthenticated" },
      });
    }
  });

  it("an explicit sign-out still removes the cookie and ends the session on the server", async () => {
    const jar = new CookieJar();
    jar.set(sessionCookie(A, inAWeek()));
    const out = await deleteSession(
      from(jar, "DELETE", "/api/client-hub/session"),
    );
    expect(out.status).toBe(200);
    expect(data.endSession).toHaveBeenCalledWith({}, A, false);
    jar.apply(out);
    expect(jar.get(CLIENT_HUB_COOKIE)).toBeNull();
  });

  it("the session cookie stays out of reach of scripts and of every other path", () => {
    const cookie = sessionCookie(B, inAWeek());
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/client-hub/);
    const jar = new CookieJar();
    jar.set(cookie);
    expect(jar.header("/espace")).toBe("");
    expect(jar.header("/api/client-hub/me")).toBe(`${CLIENT_HUB_COOKIE}=${B}`);
  });
});
