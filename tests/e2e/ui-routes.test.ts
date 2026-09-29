import { randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, inject, it } from "vitest";

import type { Database } from "@/types/database.generated";

// The auth and onboarding screens of the UI branch, served by `next start`
// against the real local Supabase stack: every route lands on the right
// page, and guarded routes answer with a redirect before any private markup.

const env = inject("e2e");
const APP = env.appUrl;
const PASSWORD = "correct-horse-battery";

/** Cookies of one browser on the app origin. */
class Browser {
  private readonly cookies = new Map<string, string>();

  header() {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  supabase() {
    return createServerClient<Database>(env.apiUrl, env.anonKey, {
      cookies: {
        getAll: () =>
          [...this.cookies].map(([name, value]) => ({ name, value })),
        setAll: (list) =>
          list.forEach(({ name, value, options }) =>
            !value || options?.maxAge === 0
              ? this.cookies.delete(name)
              : this.cookies.set(name, value),
          ),
      },
    });
  }

  async get(path: string) {
    const response = await fetch(new URL(path, APP), {
      redirect: "manual",
      headers: { cookie: this.header() },
    });
    return {
      status: response.status,
      location: response.headers.get("location"),
      html: await response.text(),
    };
  }
}

const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A confirmed account signed in in a fresh browser. */
async function signedInBrowser() {
  const email = `ui-${randomUUID().slice(0, 8)}@test.local`;
  const { error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  expect(error).toBeNull();

  const browser = new Browser();
  const signIn = await browser
    .supabase()
    .auth.signInWithPassword({ email, password: PASSWORD });
  expect(signIn.error).toBeNull();
  return { browser, email };
}

// Text that only exists in the body of each private page (titles live in
// <head> metadata and are not private).
const PRIVATE_BODIES = [
  "Aucun écran métier", // /app
  "Chargement de ton espace", // /onboarding
  "Ton espace est prêt.", // /app/welcome
];

function expectRedirect(
  response: { status: number; location: string | null; html: string },
  to: string,
) {
  expect(response.status).toBe(307);
  expect(new URL(response.location!, APP).pathname).toBe(to);
  // Nothing of the private pages is rendered into the redirect response.
  for (const body of PRIVATE_BODIES) expect(response.html).not.toContain(body);
}

describe("UI routes against the real backend", () => {
  it("signed out: auth screens are shown, private ones redirect to /login", async () => {
    const browser = new Browser();

    const login = await browser.get("/login");
    expect(login.status).toBe(200);
    expect(login.html).toContain("Bon retour.");

    const signup = await browser.get("/signup");
    expect(signup.status).toBe(200);
    expect(signup.html).toContain("Créer mon compte");

    expectRedirect(await browser.get("/app"), "/login");
    expectRedirect(await browser.get("/onboarding"), "/login");

    // The public booking page never requires a session.
    expect((await browser.get("/b/studio-mila")).status).not.toBe(307);
  });

  it("signed in without business: only /onboarding is reachable", async () => {
    const { browser } = await signedInBrowser();

    const onboarding = await browser.get("/onboarding");
    expect(onboarding.status).toBe(200);
    expect(onboarding.html).toContain("Chargement de ton espace");

    expectRedirect(await browser.get("/login"), "/onboarding");
    expectRedirect(await browser.get("/signup"), "/onboarding");
    expectRedirect(await browser.get("/app"), "/onboarding");
    expectRedirect(await browser.get("/app/welcome"), "/onboarding");
  });

  it("onboarded: /app is reachable and auth screens send the user there", async () => {
    const { browser } = await signedInBrowser();

    // Same payload shape as the UI sends through completeOnboardingAction.
    const { error } = await browser.supabase().rpc("complete_onboarding", {
      p_first_name: "Mila",
      p_last_name: "Laurent",
      p_business_name: "Studio Mila",
      p_slug: `studio-mila-${randomUUID().slice(0, 6)}`,
      p_timezone: "Europe/Paris",
      p_phone: "06 12 34 56 78",
      p_minimum_booking_notice_minutes: 120,
      p_maximum_booking_advance_days: 90,
      p_buffer_minutes: 10,
    });
    expect(error).toBeNull();

    const app = await browser.get("/app");
    expect(app.status).toBe(200);
    expect(app.html).toContain("Aucun écran métier");
    expect((await browser.get("/app/welcome")).html).toContain(
      "Ton espace est prêt.",
    );
    expectRedirect(await browser.get("/onboarding"), "/app");
    expectRedirect(await browser.get("/login"), "/app");
    expectRedirect(await browser.get("/signup"), "/app");
  });

  it("explains a failed confirmation link on /login", async () => {
    const page = await new Browser().get("/login?error=auth_callback_failed");
    expect(page.status).toBe(200);
    expect(page.html).toContain("Lien expiré ou déjà utilisé");
  });
});
