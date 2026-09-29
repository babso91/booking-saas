import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
