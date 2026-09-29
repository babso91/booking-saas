import { randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { inject } from "vitest";

import { signInAction, signUpAction } from "@/features/auth/actions/auth";
import { signUpWithPassword } from "@/features/auth/data/credentials";
import { getSessionState } from "@/features/auth/data/session";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

// Sign-up with email confirmation enabled, end to end:
//   signUpAction → confirmation_required → confirmation email (Mailpit)
//   → Supabase verify link → http://localhost:3000/auth/callback?code=…
//   → PKCE exchange with the verifier cookie → session → /onboarding.
//
// The Server Action itself runs in this process (Next.js only exposes an
// action over HTTP once a page imports it, which the UI branch will do);
// `next/headers` is replaced by the cookie jar of a browser on
// http://localhost:3000. Everything after sign-up goes through the real
// `next start` server: proxy, /auth/callback route and layout guards.

const env = inject("e2e");
const APP = env.appUrl;
const PASSWORD = "correct-horse-battery";

/** Cookies of one browser on the app origin. */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  getAll() {
    return [...this.cookies].map(([name, value]) => ({ name, value }));
  }

  set(name: string, value: string, options?: { maxAge?: number }) {
    if (!value || options?.maxAge === 0) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  names() {
    return [...this.cookies.keys()];
  }

  header() {
    return this.getAll()
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
  }

  clone() {
    const copy = new CookieJar();
    this.cookies.forEach((value, name) => copy.set(name, value));
    return copy;
  }

  /** Applies the Set-Cookie headers of an app response, like a browser. */
  absorb(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator);
      const value = decodeURIComponent(pair!.slice(separator + 1));
      const expired = attributes.some(
        (attribute) =>
          /^max-age=0$/i.test(attribute) ||
          (/^expires=/i.test(attribute) &&
            Date.parse(attribute.slice(8)) < Date.now()),
      );
      this.set(name, expired ? "" : value);
    }
  }

  /** Server-side Supabase client reading this browser's cookies. */
  supabase(): AppSupabaseClient {
    return createServerClient<Database>(env.apiUrl, env.anonKey, {
      cookies: {
        getAll: () => this.getAll(),
        setAll: (list) =>
          list.forEach(({ name, value, options }) =>
            this.set(name, value, options),
          ),
      },
    }) as unknown as AppSupabaseClient;
  }
}

let activeJar = new CookieJar();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => activeJar.getAll(),
    set: (name: string, value: string, options?: { maxAge?: number }) =>
      activeJar.set(name, value, options),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

/** GET on the app with the jar's cookies, never following redirects. */
async function visit(jar: CookieJar, path: string) {
  const url = new URL(path, APP);
  expect(url.origin).toBe(APP);

  const response = await fetch(url, {
    redirect: "manual",
    headers: { cookie: jar.header() },
  });
  jar.absorb(response);

  return {
    status: response.status,
    location: response.headers.get("location"),
  };
}

/** Follows app redirects; fails on a loop or on leaving the app origin. */
async function settle(jar: CookieJar, path: string) {
  const visited: string[] = [];
  let current = path;

  for (let hop = 0; hop < 5; hop += 1) {
    expect(visited).not.toContain(current);
    visited.push(current);

    const { status, location } = await visit(jar, current);
    if (status < 300 || status >= 400) return { status, visited };

    const next = new URL(location!, APP);
    expect(next.origin).toBe(APP);
    current = next.pathname + next.search;
  }

  throw new Error(`Too many redirects: ${visited.join(" → ")}`);
}

async function confirmationLink(email: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    ).then((response) => response.json());
    const message = search.messages?.[0];

    if (message) {
      const full = await fetch(
        `${env.mailpitUrl}/api/v1/message/${message.ID}`,
      ).then((response) => response.json());
      const link = /https?:\/\/\S+\/auth\/v1\/verify\?\S+/.exec(full.Text)?.[0];
      if (link) return new URL(link.replace(/&amp;/g, "&"));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No confirmation email for ${email}`);
}

/** Opens the email link like a browser: Supabase answers with a redirect. */
async function followVerifyLink(link: URL) {
  const response = await fetch(link, { redirect: "manual" });
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location")!);
}

async function signUpInBrowser(jar: CookieJar, label: string) {
  activeJar = jar;
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const result = await signUpAction({
    email,
    password: PASSWORD,
    firstName: "Mila",
    lastName: "Durand",
  });

  return { email, result };
}

beforeAll(() => {
  // Read by the Server Action (getPublicEnv) exactly as in the app.
  process.env.NEXT_PUBLIC_APP_URL = APP;
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
});

describe("sign-up with email confirmation enabled", () => {
  it("goes from sign-up to a usable /onboarding on one host", async () => {
    const browser = new CookieJar();

    // 1. Sign-up: no session yet, a PKCE verifier cookie on the app origin.
    const { email, result } = await signUpInBrowser(browser, "confirm");
    expect(result).toEqual({
      ok: true,
      data: { status: "confirmation_required", email, next: null },
    });
    expect(browser.names().some((name) => name.endsWith("code-verifier"))).toBe(
      true,
    );
    expect(await getSessionState(browser.supabase())).toEqual({
      status: "unauthenticated",
    });

    // Before confirmation: no access, and sign-in says why.
    expect(await settle(browser, "/app")).toEqual({
      status: 200,
      visited: ["/app", "/login"],
    });
    activeJar = browser.clone();
    expect(await signInAction({ email, password: PASSWORD })).toMatchObject({
      ok: false,
      error: { code: "email_not_confirmed" },
    });

    // 2. The email targets the exact, allow-listed callback on the app host.
    const link = await confirmationLink(email);
    expect(link.searchParams.get("type")).toBe("signup");
    expect(link.searchParams.get("redirect_to")).toBe(`${APP}/auth/callback`);

    // 3. Supabase verifies the token and sends the browser to the callback.
    const callback = await followVerifyLink(link);
    expect(callback.origin).toBe(APP);
    expect(callback.pathname).toBe("/auth/callback");
    expect(callback.searchParams.get("code")).toMatch(/^[0-9a-f-]{36}$/);

    // 4. The callback finds the verifier cookie, exchanges the code, sets the
    //    session cookie and hands over to the guards.
    const exchange = await visit(browser, callback.pathname + callback.search);
    expect(exchange).toEqual({ status: 307, location: `${APP}/app` });
    expect(browser.names()).toContain("sb-127-auth-token");

    // 5. A valid, confirmed session in the onboarding state.
    expect(await getSessionState(browser.supabase())).toMatchObject({
      status: "onboarding_required",
      user: { email, emailConfirmed: true },
    });

    // 6. Usable /onboarding, no redirect loop anywhere.
    expect(await settle(browser, "/app")).toEqual({
      status: 200,
      visited: ["/app", "/onboarding"],
    });
    expect(await settle(browser, "/onboarding")).toEqual({
      status: 200,
      visited: ["/onboarding"],
    });
    expect(await settle(browser, "/login")).toEqual({
      status: 200,
      visited: ["/login", "/onboarding"],
    });

    // 7. The code cannot be used twice, even with the original verifier.
    const replay = await visit(
      new CookieJar(),
      callback.pathname + callback.search,
    );
    expect(replay.location).toBe(`${APP}/login?error=auth_callback_failed`);
  });

  it("needs the PKCE verifier cookie of the browser that signed up", async () => {
    const browser = new CookieJar();
    const { email } = await signUpInBrowser(browser, "verifier");
    const callback = await followVerifyLink(await confirmationLink(email));
    const path = callback.pathname + callback.search;

    // Another browser (no verifier) cannot turn the code into a session.
    const stranger = new CookieJar();
    expect(await visit(stranger, path)).toEqual({
      status: 307,
      location: `${APP}/login?error=auth_callback_failed`,
    });
    expect(await getSessionState(stranger.supabase())).toEqual({
      status: "unauthenticated",
    });

    // The original browser still can.
    expect(await visit(browser, path)).toEqual({
      status: 307,
      location: `${APP}/app`,
    });
    expect((await getSessionState(browser.supabase())).status).toBe(
      "onboarding_required",
    );
  });

  it("rejects invalid codes and never redirects outside the app", async () => {
    const anonymous = new CookieJar();

    expect(
      await visit(anonymous, "/auth/callback?code=not-a-real-code"),
    ).toEqual({
      status: 307,
      location: `${APP}/login?error=auth_callback_failed`,
    });
    expect(await visit(anonymous, "/auth/callback")).toEqual({
      status: 307,
      location: `${APP}/login?error=auth_callback_failed`,
    });

    // Valid code with hostile `next` values: always an internal destination.
    for (const next of [
      "https://evil.example",
      "//evil.example/app",
      "/b/x",
      "/app/../x",
    ]) {
      const browser = new CookieJar();
      const { email } = await signUpInBrowser(browser, "next");
      const callback = await followVerifyLink(await confirmationLink(email));
      callback.searchParams.set("next", next);

      expect(await visit(browser, callback.pathname + callback.search)).toEqual(
        {
          status: 307,
          location: `${APP}/app`,
        },
      );
    }

    // An allow-listed `next` is honoured.
    const browser = new CookieJar();
    const { email } = await signUpInBrowser(browser, "next-ok");
    const callback = await followVerifyLink(await confirmationLink(email));
    callback.searchParams.set("next", "/onboarding");
    expect(await visit(browser, callback.pathname + callback.search)).toEqual({
      status: 307,
      location: `${APP}/onboarding`,
    });
  });

  it("ignores a redirect target outside the Auth allow-list", async () => {
    const jar = new CookieJar();
    const email = `foreign-${randomUUID().slice(0, 8)}@test.local`;

    await signUpWithPassword(
      jar.supabase(),
      { email, password: PASSWORD },
      "https://evil.example/auth/callback",
    );

    // Supabase falls back to site_url, the canonical app origin.
    const link = await confirmationLink(email);
    expect(link.searchParams.get("redirect_to")).toBe(APP);
  });

  it("answers a pending, unconfirmed registration like a new one", async () => {
    const { email } = await signUpInBrowser(new CookieJar(), "twice");

    // Supabase sends at most one email per address per second (max_frequency).
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    activeJar = new CookieJar();
    expect(
      await signUpAction({ email, password: "another-password-123" }),
    ).toEqual({
      ok: true,
      data: { status: "confirmation_required", email, next: null },
    });
  });
});
