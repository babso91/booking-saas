import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  getOnboardingStatusAction,
  signInAction,
  signUpAction,
} from "@/features/auth/actions/auth";
import {
  generateInvitationToken,
  hashInvitationToken,
} from "@/features/beta/token";
import { completeOnboardingAction } from "@/features/onboarding/actions/onboarding";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";

import {
  createBetaInvitation,
  generateInvitationToken as scriptToken,
  hashInvitationToken as scriptHash,
} from "../../scripts/beta-invite.mjs";
import {
  anonClient,
  bookingClient,
  db,
  env,
  uniqueSlug,
} from "./support/fixtures";

// The private beta (supabase/migrations/20261107090000_beta_invitations.sql,
// docs/BETA_ACCESS.md), against the real Auth and PostgreSQL: the Server
// Actions as Next.js runs them, `next/headers` being one device's cookie
// jar. Only an invited address creates an account through the product, and
// only an account with beta access creates a business, whatever the path.

class Device {
  readonly cookies = new Map<string, string>();
  getAll() {
    return [...this.cookies].map(([name, value]) => ({ name, value }));
  }
  get(name: string) {
    const value = this.cookies.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string, options?: { maxAge?: number }) {
    if (!value || options?.maxAge === 0) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

let device = new Device();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => device.getAll(),
    get: (name: string) => device.get(name),
    set: (name: string, value: string, options?: { maxAge?: number }) =>
      device.set(name, value, options),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = "Mot-de-passe-solide-2026";

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
});

const uniqueEmail = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}@test.local`;

/** As the operator's command does: the link's token, and its record. */
async function invite(email: string, days = 7) {
  const invitation = await createBetaInvitation(bookingClient(), {
    email,
    days,
    note: "test",
    appUrl: "http://localhost:3000",
  });
  const token = new URL(invitation.url).searchParams.get("invitation")!;
  return { ...invitation, token };
}

async function accountsFor(email: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from auth.users where lower(email) = lower($1)",
    [email],
  );
  return rows.map((row) => row.id);
}

async function accessOf(userId: string) {
  const { rows } = await db.query(
    "select source, invitation_id from private.beta_access where user_id = $1",
    [userId],
  );
  return rows[0] ?? null;
}

async function invitationRow(id: string) {
  const { rows } = await db.query(
    "select email, token_hash, accepted_at, accepted_by, revoked_at from private.beta_invitations where id = $1",
    [id],
  );
  return rows[0];
}

/** Her email confirmation (the link in the email Auth sends). */
async function confirmEmail(email: string) {
  const [id] = await accountsFor(email);
  await admin.auth.admin.updateUserById(id!, { email_confirm: true });
}

async function signInOnNewDevice(email: string) {
  device = new Device();
  const result = await signInAction({ email, password: PASSWORD });
  if (!result.ok) throw new Error(result.error.code);
  return result.data.next;
}

const onboarding = () => ({
  firstName: "Camille",
  lastName: "Bernard",
  businessName: "Atelier Camille",
  slug: uniqueSlug("atelier"),
});

const codeOf = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? "ok" : result.error!.code;

describe("beta invitations: the invited professional", () => {
  it("invitation → her own password → email confirmed → onboarding → her business", async () => {
    const email = uniqueEmail("camille");
    const invitation = await invite(email);
    expect(invitation.url).toMatch(
      /^http:\/\/localhost:3000\/signup\?invitation=inv_[A-Za-z0-9_-]{43}$/,
    );
    // Only the hash is stored.
    const stored = await invitationRow(invitation.id);
    expect(stored.token_hash).toBe(hashInvitationToken(invitation.token));
    expect(JSON.stringify(stored)).not.toContain(invitation.token);

    device = new Device();
    const signedUp = await signUpAction({
      email: email.toUpperCase(),
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    expect(signedUp).toEqual({
      ok: true,
      data: { status: "confirmation_required", email, next: null },
    });
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toEqual({
      source: "invitation",
      invitation_id: invitation.id,
    });
    expect(await invitationRow(invitation.id)).toMatchObject({
      accepted_by: userId,
    });
    // Her password is Auth's only: nothing of it in our tables.
    const { rows } = await db.query(
      "select count(*)::int as n from private.beta_invitations where note like $1 or email like $1",
      [`%${PASSWORD}%`],
    );
    expect(rows[0].n).toBe(0);

    await confirmEmail(email);
    expect(await signInOnNewDevice(email)).toBe("/onboarding");
    const status = await getOnboardingStatusAction();
    expect(status).toMatchObject({
      ok: true,
      data: { status: "onboarding_required", betaAccess: true },
    });

    const onboarded = await completeOnboardingAction(onboarding());
    expect(onboarded).toMatchObject({
      ok: true,
      data: { businessName: "Atelier Camille", next: "/app" },
    });
    expect(await getOnboardingStatusAction()).toMatchObject({
      ok: true,
      data: { status: "ready", next: "/app" },
    });
    // Signing in again leads to her dashboard.
    expect(await signInOnNewDevice(email)).toBe("/app");

    // The link is used now: refused, for her as for anyone.
    device = new Device();
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ),
    ).toBe("invitation_used");
  });
});

describe("beta invitations: refused", () => {
  it("no invitation, a malformed one, an unknown one: nothing is created", async () => {
    device = new Device();
    const email = uniqueEmail("nobody");
    expect(codeOf(await signUpAction({ email, password: PASSWORD }))).toBe(
      "beta_invitation_required",
    );
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: "abc",
        }),
      ),
    ).toBe("invitation_invalid");
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: generateInvitationToken(),
        }),
      ),
    ).toBe("invitation_invalid");
    expect(await accountsFor(email)).toEqual([]);
  });

  it("expired: refused, nothing created", async () => {
    const email = uniqueEmail("late");
    const invitation = await invite(email, 1);
    await db.query(
      "update private.beta_invitations set created_at = now() - interval '3 days', expires_at = now() - interval '1 second' where id = $1",
      [invitation.id],
    );
    device = new Device();
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ),
    ).toBe("invitation_expired");
    expect(await accountsFor(email)).toEqual([]);
  });

  it("for another address: refused, the invited address not revealed", async () => {
    const invited = uniqueEmail("invited");
    const other = uniqueEmail("other");
    const invitation = await invite(invited);
    device = new Device();
    const answer = await signUpAction({
      email: other,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    expect(codeOf(answer)).toBe("invitation_email_mismatch");
    expect(JSON.stringify(answer)).not.toContain(invited);
    expect(await accountsFor(other)).toEqual([]);
    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();
  });

  it("a newer invitation for the same address replaces the older link", async () => {
    const email = uniqueEmail("twice");
    const first = await invite(email);
    const second = await invite(email);
    expect((await invitationRow(first.id)).revoked_at).not.toBeNull();
    device = new Device();
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: first.token,
        }),
      ),
    ).toBe("invitation_invalid");
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: second.token,
        }),
      ),
    ).toBe("ok");
  });

  it("the operator's command: 1 to 30 days, a valid address, the same token format", async () => {
    await expect(
      createBetaInvitation(bookingClient(), {
        email: uniqueEmail("long"),
        days: 31,
        appUrl: "http://localhost:3000",
      }),
    ).rejects.toThrow(/days/);
    await expect(
      createBetaInvitation(bookingClient(), {
        email: "not an address",
        days: 7,
        appUrl: "http://localhost:3000",
      }),
    ).rejects.toThrow(/refused/);
    // The database holds the same bounds, whoever calls it.
    for (const expiresAt of [
      new Date(Date.now() + 31 * 86_400_000),
      new Date(Date.now() - 1000),
    ]) {
      const { error } = await bookingClient().rpc("create_beta_invitation", {
        p_email: uniqueEmail("bounds"),
        p_token_hash: hashInvitationToken(generateInvitationToken()),
        p_expires_at: expiresAt.toISOString(),
      });
      expect(error).not.toBeNull();
    }
    const token = scriptToken();
    expect(token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/);
    expect(scriptHash(token)).toBe(hashInvitationToken(token));
  });
});

describe("beta invitations: no way around", () => {
  it("an account made directly with Auth, without the product: no business, whatever the path", async () => {
    const email = uniqueEmail("direct");
    // Straight to Supabase Auth with the publishable key (bypassing our
    // actions), then confirmed.
    const { error } = await anonClient().auth.signUp({
      email,
      password: PASSWORD,
    });
    expect(error).toBeNull();
    await confirmEmail(email);

    expect(await signInOnNewDevice(email)).toBe("/onboarding");
    expect(await getOnboardingStatusAction()).toMatchObject({
      ok: true,
      data: { status: "onboarding_required", betaAccess: false },
    });
    // Through the action.
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe(
      "beta_invitation_required",
    );
    // Through the database function, with her own session.
    const session = await createServerSupabaseClient();
    const { error: rpcError } = await session.rpc("complete_onboarding", {
      p_first_name: "X",
      p_last_name: "Y",
      p_business_name: "Contournement",
      p_slug: uniqueSlug("bypass"),
    });
    expect(rpcError?.message).toBe("beta_invitation_required");
    // Nor can she grant herself access, create or accept an invitation.
    const forged = generateInvitationToken();
    for (const [name, args] of [
      [
        "create_beta_invitation",
        {
          p_email: email,
          p_token_hash: hashInvitationToken(forged),
          p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      [
        "accept_beta_invitation",
        { p_token_hash: hashInvitationToken(forged), p_email: email },
      ],
      [
        "check_beta_invitation",
        { p_token_hash: hashInvitationToken(forged), p_email: email },
      ],
      ["revoke_beta_invitation", { p_invitation_id: randomUUID() }],
    ] as const) {
      for (const client of [session, anonClient()]) {
        const { error: refused } = await client.rpc(
          name as never,
          args as never,
        );
        expect(refused, name).not.toBeNull();
      }
    }
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toBeNull();
    const { rows } = await db.query(
      "select count(*)::int as n from public.businesses where created_by = $1",
      [userId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("an invitation for HER address, signed in as someone else: her account only gets the access", async () => {
    // Someone holding Camille's link cannot give access to their own account.
    const camille = uniqueEmail("camille2");
    const intruder = uniqueEmail("intruder");
    const invitation = await invite(camille);
    await anonClient().auth.signUp({ email: intruder, password: PASSWORD });
    await confirmEmail(intruder);
    await signInOnNewDevice(intruder);
    // Signing up with Camille's link and the intruder's address: refused.
    expect(
      codeOf(
        await signUpAction({
          email: intruder,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ),
    ).toBe("invitation_email_mismatch");
    const [intruderId] = await accountsFor(intruder);
    expect(await accessOf(intruderId!)).toBeNull();
  });
});

describe("beta invitations: concurrency and interruptions", () => {
  it("the same link sent twice at once: one account, accepted once", async () => {
    const email = uniqueEmail("double");
    const invitation = await invite(email);
    device = new Device();
    const answers = await Promise.all([
      signUpAction({
        email,
        password: PASSWORD,
        invitationToken: invitation.token,
      }),
      signUpAction({
        email,
        password: PASSWORD,
        invitationToken: invitation.token,
      }),
    ]);
    // Each answer is a success, or Auth's refusal of a simultaneous sign-up
    // for the same address (its "Database error saving new user", answered
    // `internal`): never a second account, never a second use.
    for (const answer of answers) {
      expect(["ok", "email_taken", "rate_limited", "internal"]).toContain(
        codeOf(answer),
      );
    }
    expect(answers.some((answer) => answer.ok)).toBe(true);
    const accounts = await accountsFor(email);
    expect(accounts).toHaveLength(1);
    expect(await accessOf(accounts[0]!)).toMatchObject({
      source: "invitation",
    });
    const { rows } = await db.query(
      "select count(*)::int as n from private.beta_access where invitation_id = $1",
      [invitation.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("many acceptances at once (service): accepted once, for her account", async () => {
    const email = uniqueEmail("rush");
    const invitation = await invite(email);
    await anonClient().auth.signUp({ email, password: PASSWORD });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        bookingClient().rpc("accept_beta_invitation", {
          p_token_hash: hashInvitationToken(invitation.token),
          p_email: email,
        }),
      ),
    );
    expect(results.map((result) => result.data)).toEqual(
      Array(6).fill("accepted"),
    );
    const [userId] = await accountsFor(email);
    expect(await invitationRow(invitation.id)).toMatchObject({
      accepted_by: userId,
    });
  });

  it("interrupted after Auth created her account: the same link finishes it", async () => {
    const email = uniqueEmail("interrupted");
    const invitation = await invite(email);
    // The first attempt: Auth created the account, then the request died
    // before the invitation was accepted.
    await anonClient().auth.signUp({ email, password: PASSWORD });
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toBeNull();

    // She opens the link again and signs up again (not confirmed yet): her
    // access is given whatever Auth answers (the confirmation sent again,
    // or `rate_limited` right after the first attempt).
    device = new Device();
    const again = await signUpAction({
      email,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    expect(["ok", "rate_limited"]).toContain(codeOf(again));
    expect(await accessOf(userId!)).toMatchObject({ source: "invitation" });
    expect(await accountsFor(email)).toEqual([userId]);

    await confirmEmail(email);
    await signInOnNewDevice(email);
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
  });

  it("interrupted after she confirmed her email: the link gives access, she signs in", async () => {
    const email = uniqueEmail("confirmed");
    const invitation = await invite(email);
    await anonClient().auth.signUp({ email, password: PASSWORD });
    await confirmEmail(email);
    device = new Device();
    // Her account exists and is confirmed: Auth says so; her access is given.
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ),
    ).toBe("email_taken");
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toMatchObject({ source: "invitation" });
    await signInOnNewDevice(email);
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
  });

  it("retried after onboarding started on another device: the same answer, one business", async () => {
    const email = uniqueEmail("retry");
    const invitation = await invite(email);
    device = new Device();
    await signUpAction({
      email,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    // Retried (lost answer) before onboarding: still valid for her (Auth
    // may ask her to wait before sending its email again).
    expect(["ok", "rate_limited"]).toContain(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ),
    );
    const [first] = await accountsFor(email);
    expect(await accessOf(first!)).toMatchObject({ source: "invitation" });
    await confirmEmail(email);
    await signInOnNewDevice(email);
    const input = onboarding();
    const [a, b] = await Promise.all([
      completeOnboardingAction(input),
      completeOnboardingAction(input),
    ]);
    expect([codeOf(a), codeOf(b)].sort()).toEqual(["already_onboarded", "ok"]);
    const [userId] = await accountsFor(email);
    const { rows } = await db.query(
      "select count(*)::int as n from public.business_members where user_id = $1",
      [userId],
    );
    expect(rows[0].n).toBe(1);
  });
});
