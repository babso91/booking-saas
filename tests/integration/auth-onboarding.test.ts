import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  signInWithPassword,
  signOut,
  signUpWithPassword,
} from "@/features/auth/data/credentials";
import { getSessionState } from "@/features/auth/data/session";
import { getPublicBusiness } from "@/features/businesses/data/public-business";
import {
  checkSlugAvailability,
  completeOnboarding,
} from "@/features/onboarding/data/onboarding";
import {
  completeOnboardingSchema,
  type CompleteOnboardingInput,
} from "@/features/onboarding/schemas/onboarding";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import { anonClient, db, env } from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
} from "./support/transactions";

// Professional authentication and onboarding against the real local stack:
// Supabase Auth (GoTrue), PostgREST and PostgreSQL. Local config has email
// confirmation disabled, so sign-up returns a session immediately.

const REDIRECT = "http://localhost:3000/auth/callback";
const PASSWORD = "correct-horse-battery";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@test.local`;
}

function uniqueSlug(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function signedUpUser(label = "pro") {
  const client = anonClient();
  const email = uniqueEmail(label);
  await signUpWithPassword(
    client,
    { email, password: PASSWORD, firstName: "Mila", lastName: "Durand" },
    REDIRECT,
  );
  const { data } = await client.auth.getUser();

  return { client, email, userId: data.user!.id };
}

function onboardingInput(overrides: Partial<Record<string, unknown>> = {}) {
  return completeOnboardingSchema.parse({
    firstName: "Mila",
    lastName: "Durand",
    businessName: "Studio Mila Lashes",
    slug: uniqueSlug("studio"),
    ...overrides,
  });
}

async function countRowsFor(userId: string) {
  const { rows } = await db.query<{
    businesses: number;
    members: number;
    settings: number;
    loyalty: number;
    onboardings: number;
  }>(
    `select
       (select count(*)::int from public.businesses where created_by = $1) as businesses,
       (select count(*)::int from public.business_members where user_id = $1) as members,
       (select count(*)::int from public.business_settings s
          join public.businesses b on b.id = s.business_id where b.created_by = $1) as settings,
       (select count(*)::int from public.loyalty_programs l
          join public.businesses b on b.id = l.business_id where b.created_by = $1) as loyalty,
       (select count(*)::int from public.business_onboardings where user_id = $1) as onboardings`,
    [userId],
  );

  return rows[0]!;
}

const ONE_OF_EACH = {
  businesses: 1,
  members: 1,
  settings: 1,
  loyalty: 1,
  onboardings: 1,
};
const NONE = {
  businesses: 0,
  members: 0,
  settings: 0,
  loyalty: 0,
  onboardings: 0,
};

describe("authentication", () => {
  it("signs up with email and password and starts at onboarding", async () => {
    const client = anonClient();
    const email = uniqueEmail("signup");

    await expect(
      signUpWithPassword(
        client,
        { email, password: PASSWORD, firstName: "Léa", lastName: "Martin" },
        REDIRECT,
      ),
    ).resolves.toEqual({ status: "signed_in" });

    const state = await getSessionState(client);
    expect(state).toMatchObject({
      status: "onboarding_required",
      user: { email, emailConfirmed: true },
    });

    // The existing trigger created the profile from the sign-up metadata.
    const { rows } = await db.query(
      "select first_name, last_name from public.profiles where id = $1",
      [state.status === "onboarding_required" ? state.user.id : null],
    );
    expect(rows).toEqual([{ first_name: "Léa", last_name: "Martin" }]);
  });

  it("refuses a second account with the same email", async () => {
    const { email } = await signedUpUser("duplicate");

    await expect(
      signUpWithPassword(anonClient(), { email, password: PASSWORD }, REDIRECT),
    ).rejects.toMatchObject({ code: "email_taken" });
  });

  it("signs in, and refuses wrong or unknown credentials the same way", async () => {
    const { email } = await signedUpUser("signin");
    const client = anonClient();

    await expect(
      signInWithPassword(client, { email, password: "wrong-password!" }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(
      signInWithPassword(client, {
        email: uniqueEmail("nobody"),
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });

    await signInWithPassword(client, { email, password: PASSWORD });
    expect((await getSessionState(client)).status).toBe("onboarding_required");
  });

  it("reports an unconfirmed email explicitly", async () => {
    const admin = createClient(env.apiUrl, env.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = uniqueEmail("unconfirmed");
    await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: false,
    });

    await expect(
      signInWithPassword(anonClient(), { email, password: PASSWORD }),
    ).rejects.toMatchObject({ code: "email_not_confirmed" });
  });

  it("signs out and invalidates the session server-side", async () => {
    const { client } = await signedUpUser("signout");
    const { data } = await client.auth.getSession();
    const accessToken = data.session!.access_token;

    await signOut(client);

    expect(await getSessionState(client)).toEqual({
      status: "unauthenticated",
    });

    // Replaying the old access token: the Auth server no longer knows the session.
    const replay = createClient(env.apiUrl, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: user, error } = await replay.auth.getUser(accessToken);
    expect(user.user).toBeNull();
    expect(error).not.toBeNull();
  });

  it("treats a visitor without session as unauthenticated", async () => {
    expect(await getSessionState(anonClient())).toEqual({
      status: "unauthenticated",
    });
  });
});

describe("onboarding", () => {
  it("creates profile, business, settings, owner membership and loyalty program", async () => {
    const { client, userId, email } = await signedUpUser("onboard");
    const input = onboardingInput({
      firstName: "  Camille ",
      lastName: "Bernard",
      businessName: "  Écrin de Camille ",
      slug: "  Écrin de Camille  ",
      description: "Extensions de cils",
      phone: "+33 6 12 34 56 78",
      location: "Lyon 2e",
      timezone: "Europe/Paris",
      cancellationPolicy: "24 h à l’avance",
      minimumBookingNoticeMinutes: 60,
      maximumBookingAdvanceDays: 45,
      bufferMinutes: 10,
    });
    // Unique slug per run, still exercising normalisation.
    input.slug = `${input.slug} ${randomUUID().slice(0, 6)}`;

    const result = await completeOnboarding(client, input);

    expect(result.slug).toMatch(/^ecrin-de-camille-[0-9a-f]{6}$/);
    expect(result).toMatchObject({
      businessName: "Écrin de Camille",
      timezone: "Europe/Paris",
    });
    expect(await countRowsFor(userId)).toEqual(ONE_OF_EACH);

    const { rows } = await db.query(
      `select b.name, b.contact_email, b.phone, b.location, b.description,
              b.cancellation_policy, s.minimum_booking_notice_minutes as notice,
              s.maximum_booking_advance_days as horizon, s.buffer_minutes as buffer,
              m.role, l.active as loyalty_active, l.points_per_completed_appointment as points,
              p.first_name, p.last_name
       from public.businesses b
       join public.business_settings s on s.business_id = b.id
       join public.business_members m on m.business_id = b.id
       join public.loyalty_programs l on l.business_id = b.id
       join public.profiles p on p.id = m.user_id
       where b.id = $1`,
      [result.businessId],
    );
    expect(rows).toEqual([
      {
        name: "Écrin de Camille",
        contact_email: email,
        phone: "+33 6 12 34 56 78",
        location: "Lyon 2e",
        description: "Extensions de cils",
        cancellation_policy: "24 h à l’avance",
        notice: 60,
        horizon: 45,
        buffer: 10,
        role: "owner",
        loyalty_active: true,
        points: 1,
        first_name: "Camille",
        last_name: "Bernard",
      },
    ]);

    expect(await getSessionState(client)).toMatchObject({
      status: "ready",
      business: {
        id: result.businessId,
        slug: result.slug,
        name: "Écrin de Camille",
      },
    });

    // The new business is immediately public.
    await expect(
      getPublicBusiness(anonClient(), result.slug),
    ).resolves.toMatchObject({
      slug: result.slug,
      name: "Écrin de Camille",
    });
  });

  it("is refused to anonymous callers", async () => {
    const anon = anonClient();

    await expect(
      completeOnboarding(anon, onboardingInput()),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      checkSlugAvailability(anon, "studio-libre"),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("rolls everything back when a late step fails", async () => {
    const { client, userId } = await signedUpUser("rollback");
    const input = onboardingInput();

    // Makes the very last write of the transaction fail for this user only.
    await db.query(`
      create function public.test_fail_onboarding() returns trigger
      language plpgsql as $$ begin
        if new.user_id = '${userId}' then raise exception 'provoked failure'; end if;
        return new;
      end $$;
      create trigger test_fail_onboarding before insert on public.business_onboardings
        for each row execute function public.test_fail_onboarding();
    `);

    try {
      await expect(completeOnboarding(client, input)).rejects.toMatchObject({
        code: "internal",
      });
    } finally {
      await db.query(`
        drop trigger test_fail_onboarding on public.business_onboardings;
        drop function public.test_fail_onboarding();
      `);
    }

    expect(await countRowsFor(userId)).toEqual(NONE);
    const { rows } = await db.query(
      "select 1 from public.businesses where slug = $1",
      [input.slug],
    );
    expect(rows).toEqual([]);
    const profile = await db.query(
      "select first_name, last_name from public.profiles where id = $1",
      [userId],
    );
    expect(profile.rows).toEqual([{ first_name: "Mila", last_name: "Durand" }]);
    expect((await getSessionState(client)).status).toBe("onboarding_required");

    // Nothing left behind: the same request now succeeds.
    await expect(completeOnboarding(client, input)).resolves.toMatchObject({
      slug: input.slug,
    });
  });
});

describe("idempotence", () => {
  it("answers already_onboarded to any later call, creating nothing", async () => {
    const { client, userId } = await signedUpUser("twice");
    const first = await completeOnboarding(client, onboardingInput());

    await expect(
      completeOnboarding(client, onboardingInput({ businessName: "Autre" })),
    ).rejects.toMatchObject({ code: "already_onboarded" });

    expect(await countRowsFor(userId)).toEqual(ONE_OF_EACH);
    expect(await getSessionState(client)).toMatchObject({
      status: "ready",
      business: { id: first.businessId },
    });
  });

  it("creates exactly one business from simultaneous submissions", async () => {
    const { client, userId } = await signedUpUser("burst");
    const input = onboardingInput();

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => completeOnboarding(client, input)),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason.code),
    ).toEqual(Array.from({ length: 5 }, () => "already_onboarded"));
    expect(await countRowsFor(userId)).toEqual(ONE_OF_EACH);
  });

  it("serialises a double submission: the second waits, then gets already_onboarded", async () => {
    const { userId } = await signedUpUser("serial");
    const call = (slug: string) =>
      `select * from public.complete_onboarding('Mila', 'Durand', 'Studio', '${slug}')`;

    const first = await openTransaction({ role: "authenticated", userId });
    const second = await openTransaction({ role: "authenticated", userId });

    await first.connection.query(call(uniqueSlug("first")));
    const secondResult = outcome(
      second.connection.query(call(uniqueSlug("second"))),
    );
    await waitUntilBlocked(second.pid);

    await closeTransaction(first, "commit");
    expect(await secondResult).toBe("already_onboarded");
    await closeTransaction(second, "rollback");

    expect(await countRowsFor(userId)).toEqual(ONE_OF_EACH);
  });
});

describe("public slug", () => {
  let user: { client: AppSupabaseClient; userId: string };

  it("normalises spaces, case, accents, punctuation and hyphens", async () => {
    user = await signedUpUser("slug");
    const suffix = randomUUID().slice(0, 6);

    await expect(
      checkSlugAvailability(user.client, `  Beauté  & Cils -- ÉTÉ ${suffix} `),
    ).resolves.toEqual({
      slug: `beaute-cils-ete-${suffix}`,
      available: true,
      reason: "available",
    });
    await expect(
      checkSlugAvailability(user.client, "Straße_Ærø"),
    ).resolves.toMatchObject({ slug: "strasse-aero" });
    await expect(
      checkSlugAvailability(user.client, "x".repeat(100)),
    ).resolves.toMatchObject({ slug: "x".repeat(63) });
  });

  it("refuses slugs that are too short after normalisation", async () => {
    user = await signedUpUser("short");

    await expect(checkSlugAvailability(user.client, " a! ")).resolves.toEqual({
      slug: "a",
      available: false,
      reason: "invalid",
    });
    await expect(
      completeOnboarding(user.client, onboardingInput({ slug: "!!" })),
    ).rejects.toMatchObject({
      code: "validation_error",
      fieldErrors: { slug: expect.any(Array) },
    });
  });

  it.each([
    "admin",
    "API",
    "App",
    "login",
    "signup",
    "Onboarding",
    "settings",
    "support",
  ])("refuses the reserved slug %s", async (slug) => {
    user = await signedUpUser("reserved");

    await expect(
      checkSlugAvailability(user.client, slug),
    ).resolves.toMatchObject({ available: false, reason: "reserved" });
    await expect(
      completeOnboarding(user.client, onboardingInput({ slug })),
    ).rejects.toMatchObject({ code: "slug_reserved" });
  });

  it("keeps reserved and malformed slugs out of the database whatever the path", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.profiles limit 1",
    );

    for (const slug of ["api", "ab", "Bad Slug"]) {
      await expect(
        db.query(
          `insert into public.businesses (name, slug, contact_email, created_by)
           values ('X', $1, 'x@x.fr', $2)`,
          [slug, rows[0]!.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("refuses a slug already used by another business, whatever its spelling", async () => {
    const owner = await signedUpUser("taken-a");
    const other = await signedUpUser("taken-b");
    const base = uniqueSlug("atelier");
    await completeOnboarding(owner.client, onboardingInput({ slug: base }));

    await expect(
      checkSlugAvailability(other.client, base.toUpperCase()),
    ).resolves.toMatchObject({ available: false, reason: "taken" });
    await expect(
      completeOnboarding(
        other.client,
        onboardingInput({ slug: ` ${base.toUpperCase()} ` }),
      ),
    ).rejects.toMatchObject({
      code: "slug_taken",
      fieldErrors: { slug: expect.any(Array) },
    });
    expect(await countRowsFor(other.userId)).toEqual(NONE);
  });

  it("never creates two businesses for the same slug under concurrency", async () => {
    const a = await signedUpUser("race-a");
    const b = await signedUpUser("race-b");
    const slug = uniqueSlug("race");
    const call = `select * from public.complete_onboarding('Mila', 'Durand', 'Studio', '${slug}')`;

    const first = await openTransaction({
      role: "authenticated",
      userId: a.userId,
    });
    const second = await openTransaction({
      role: "authenticated",
      userId: b.userId,
    });

    await first.connection.query(call);
    // B's availability pre-check cannot see A's uncommitted row; the unique
    // constraint makes B wait, then fail.
    const secondResult = outcome(second.connection.query(call));
    await waitUntilBlocked(second.pid);
    await closeTransaction(first, "commit");

    expect(await secondResult).toBe("slug_taken");
    await closeTransaction(second, "rollback");

    const { rows } = await db.query(
      "select created_by from public.businesses where slug = $1",
      [slug],
    );
    expect(rows).toEqual([{ created_by: a.userId }]);
  });

  it("gives the slug to exactly one of many simultaneous users", async () => {
    const users = await Promise.all(
      Array.from({ length: 5 }, (_, index) => signedUpUser(`crowd-${index}`)),
    );
    const slug = uniqueSlug("crowd");

    const results = await Promise.allSettled(
      users.map((u) => completeOnboarding(u.client, onboardingInput({ slug }))),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason.code),
    ).toEqual(Array.from({ length: 4 }, () => "slug_taken"));
  });
});

describe("ownership and tenant isolation", () => {
  it("offers no way to onboard on behalf of another user", async () => {
    const a = await signedUpUser("owner-a");
    const b = await signedUpUser("owner-b");

    // There is no user parameter: an extra one makes the call unresolvable.
    const { error } = await a.client.rpc(
      "complete_onboarding" as never,
      {
        p_first_name: "A",
        p_last_name: "A",
        p_business_name: "A",
        p_slug: uniqueSlug("forged"),
        p_user_id: b.userId,
      } as never,
    );
    expect(error?.code).toBe("PGRST202");

    const result = await completeOnboarding(a.client, onboardingInput());
    const { rows } = await db.query(
      `select b.created_by, m.user_id, o.user_id as onboarded_user
       from public.businesses b
       join public.business_members m on m.business_id = b.id
       join public.business_onboardings o on o.business_id = b.id
       where b.id = $1`,
      [result.businessId],
    );
    expect(rows).toEqual([
      { created_by: a.userId, user_id: a.userId, onboarded_user: a.userId },
    ]);
    expect(await countRowsFor(b.userId)).toEqual(NONE);
  });

  it("cannot write businesses, memberships or onboarding records directly", async () => {
    const a = await signedUpUser("direct-a");
    const b = await signedUpUser("direct-b");
    const target = await completeOnboarding(b.client, onboardingInput());

    const business = await a.client.from("businesses").insert({
      name: "Direct",
      slug: uniqueSlug("direct"),
      contact_email: "d@x.fr",
      created_by: a.userId,
    });
    const membership = await a.client.from("business_members").insert({
      business_id: target.businessId,
      user_id: a.userId,
      role: "owner",
    });
    const record = await a.client
      .from("business_onboardings")
      .insert({ user_id: a.userId, business_id: target.businessId });

    for (const result of [business, membership, record]) {
      expect(result.error?.code).toBe("42501");
    }
    expect(await countRowsFor(a.userId)).toEqual(NONE);
  });

  it("keeps RLS A/B intact after onboarding", async () => {
    const a = await signedUpUser("rls-a");
    const b = await signedUpUser("rls-b");
    const businessA = await completeOnboarding(a.client, onboardingInput());
    const businessB = await completeOnboarding(b.client, onboardingInput());

    for (const [table, column] of [
      ["businesses", "id"],
      ["business_settings", "business_id"],
      ["business_members", "business_id"],
      ["loyalty_programs", "business_id"],
      ["business_onboardings", "business_id"],
    ] as const) {
      // Table names vary per case: use the schema-agnostic client type.
      const client = a.client as unknown as SupabaseClient;
      const own = await client
        .from(table)
        .select("*")
        .eq(column, businessA.businessId);
      const foreign = await client
        .from(table)
        .select("*")
        .eq(column, businessB.businessId);

      expect(own.data).toHaveLength(1);
      expect(foreign.error).toBeNull();
      expect(foreign.data).toEqual([]);
    }

    // B's settings cannot be changed by A.
    await a.client
      .from("business_settings")
      .update({ buffer_minutes: 99 })
      .eq("business_id", businessB.businessId);
    const { rows } = await db.query(
      "select buffer_minutes from public.business_settings where business_id = $1",
      [businessB.businessId],
    );
    expect(rows).toEqual([{ buffer_minutes: 0 }]);
  });
});

describe("validation", () => {
  it.each([
    ["timezone", { timezone: "Mars/Olympus" }],
    ["minimumBookingNoticeMinutes", { minimumBookingNoticeMinutes: 99999 }],
    ["bufferMinutes", { bufferMinutes: -5 }],
    ["phone", { phone: "call me" }],
  ])(
    "re-validates %s in the database, even bypassing Zod",
    async (field, override) => {
      const { client } = await signedUpUser("invalid");
      const input = {
        ...onboardingInput(),
        ...override,
      } as CompleteOnboardingInput;

      await expect(completeOnboarding(client, input)).rejects.toMatchObject({
        code: "validation_error",
        fieldErrors: { [field]: expect.any(Array) },
      });
    },
  );
});
