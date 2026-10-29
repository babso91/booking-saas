import { randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import type { Database } from "@/types/database.generated";

// Studio 1 against the real backend (`next start` + local Supabase): the
// "Aujourd’hui" page reads her day through the agenda's own read (RLS), in
// her style only, never another business's visits, and a hostile appearance
// cookie never breaks a page.

const env = inject("e2e");
const APP = env.appUrl;
const PASSWORD = "correct-horse-battery";
const db = new pg.Pool({ connectionString: env.dbUrl, max: 4 });

afterAll(() => db.end());

const STUDIO = "atelier.light.standard.-.studio";

/** Cookies of one browser on the app origin. */
class Browser {
  readonly cookies = new Map<string, string>();

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

/** A signed-in professional with her business, and one visit going on now. */
async function professionalWithVisit(name: string, client: string) {
  const email = `studio-${randomUUID().slice(0, 8)}@test.local`;
  const created = await fetch(`${env.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env.serviceRoleKey,
      authorization: `Bearer ${env.serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  expect(created.ok).toBe(true);

  const browser = new Browser();
  const signIn = await browser
    .supabase()
    .auth.signInWithPassword({ email, password: PASSWORD });
  expect(signIn.error).toBeNull();

  const slug = `studio-${randomUUID().slice(0, 8)}`;
  const { error } = await browser.supabase().rpc("complete_onboarding", {
    p_first_name: name,
    p_last_name: "Test",
    p_business_name: `Atelier ${name}`,
    p_slug: slug,
    p_timezone: "Europe/Paris",
    p_phone: "06 12 34 56 78",
    p_minimum_booking_notice_minutes: 120,
    p_maximum_booking_advance_days: 90,
    p_buffer_minutes: 0,
  });
  expect(error).toBeNull();

  const { rows } = await db.query<{ id: string }>(
    "select id from public.businesses where slug = $1",
    [slug],
  );
  const businessId = rows[0]!.id;
  const service = await db.query<{ id: string }>(
    `insert into public.services (business_id, name, duration_minutes, price_cents)
     values ($1, 'Rehaussement de cils', 75, 6000) returning id`,
    [businessId],
  );
  const customer = await db.query<{ id: string }>(
    `insert into public.clients (business_id, first_name, last_name, email)
     values ($1, $2, 'Visite', $3) returning id`,
    [businessId, client, `${slug}@client.test.local`],
  );
  // Began 30 minutes ago, ends in 45: a slot going on now, whatever the
  // hour of the run (across midnight included).
  const visit = await db.query<{ id: string }>(
    `insert into public.appointments (
       business_id, client_id, service_id, starts_at, ends_at, status,
       service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot,
       buffer_minutes_snapshot
     )
     values ($1, $2, $3, now() - interval '30 minutes',
             now() + interval '45 minutes', 'confirmed',
             'Rehaussement de cils', 75, 6000, 0)
     returning id`,
    [businessId, customer.rows[0]!.id, service.rows[0]!.id],
  );

  return { browser, businessId, appointmentId: visit.rows[0]!.id };
}

describe("Studio 1 against the real backend", () => {
  it("signed out: « Aujourd’hui » leads to /login", async () => {
    const response = await new Browser().get("/app/today");
    expect(response.status).toBe(307);
    expect(new URL(response.location!, APP).pathname).toBe("/login");
  });

  it("Studio: her slot going on now, from her agenda only", async () => {
    const mine = await professionalWithVisit("Maëlys", "Inès");
    const theirs = await professionalWithVisit("Alma", "Zélie");

    mine.browser.cookies.set("dash_appearance", STUDIO);
    const today = await mine.browser.get("/app/today");
    expect(today.status).toBe(200);
    expect(today.html).toContain("Créneau en cours");
    expect(today.html).toContain("Inès Visite");
    // Another business's visit is never read, not even into the payload.
    expect(today.html).not.toContain("Zélie");
    expect(today.html).not.toContain(theirs.appointmentId);
    // Her visit leads to the agenda with its details.
    expect(today.html).toContain(`rdv=${mine.appointmentId}`);
  });

  it("Classique: this address leads to the agenda", async () => {
    const { browser } = await professionalWithVisit("Jade", "Rose");
    browser.cookies.set(
      "dash_appearance",
      "atelier.light.standard.-.classique",
    );
    const response = await browser.get("/app/today");
    expect(response.status).toBe(307);
    expect(new URL(response.location!, APP).pathname).toBe("/app");
  });

  it("a hostile appearance cookie never breaks a page (no 500)", async () => {
    const { browser } = await professionalWithVisit("Lina", "Nour");
    for (const value of [
      "constructor.dark.none.-.studio",
      "__proto__.light.standard.-.studio",
      "toString.toString.toString.toString.toString",
      "lin.dark.none.zzzzzz.studio;}body{display:none",
      "%E0%A4%A",
    ]) {
      browser.cookies.set("dash_appearance", value);
      for (const path of ["/app", "/app/today", "/app/settings/appearance"]) {
        const response = await browser.get(path);
        expect([200, 307], `${value} ${path}`).toContain(response.status);
        expect(response.html).not.toContain("display:none");
      }
    }
  });
});
