import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { GET as authCallback } from "@/app/auth/callback/route";
import {
  completeInvitationAction,
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
import {
  closeTransaction,
  openTransaction,
  outcome,
  type OpenTransaction,
} from "./support/transactions";

/** Resolves once backend `pid` waits on a lock, or has finished its statement. */
async function waitUntilBlockedOrDone(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await db.query(
      "select 1 from pg_stat_activity where pid = $1 and (wait_event_type = 'Lock' or state = 'idle in transaction')",
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Backend ${pid} neither blocked nor finished`);
}

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
  delete(name: string) {
    this.cookies.delete(name);
  }
}

let device = new Device();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => device.getAll(),
    get: (name: string) => device.get(name),
    set: (name: string, value: string, options?: { maxAge?: number }) =>
      device.set(name, value, options),
    delete: (name: string) => device.delete(name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// The service's Auth admin calls are counted: the invitation never changes
// an account's password (`updateUserById`), whatever its state.
const adminCalls = { updateUserById: 0 };
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return {
    createAdminSupabaseClient: () => {
      const client = actual.createAdminSupabaseClient();
      const update = client.auth.admin.updateUserById.bind(client.auth.admin);
      client.auth.admin.updateUserById = ((
        ...args: Parameters<typeof update>
      ) => {
        adminCalls.updateUserById += 1;
        return update(...args);
      }) as typeof update;
      return client;
    },
  };
});

// Hooks on her device's Auth calls (the server client): `beforeRecovery`
// runs just before the recovery link is requested (the real owner
// confirming her address between two server calls); `signOutOthers`
// replaces ending the other sessions (Auth failing, or pretending to
// succeed without ending them).
const serverHooks: {
  beforeRecovery?: () => Promise<void>;
  signOutOthers?: () => Promise<{ error: { code: string } | null }>;
} = {};
vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  return {
    ...actual,
    createServerSupabaseClient: async (
      ...args: Parameters<typeof actual.createServerSupabaseClient>
    ) => {
      const client = await actual.createServerSupabaseClient(...args);
      const recover = client.auth.resetPasswordForEmail.bind(client.auth);
      client.auth.resetPasswordForEmail = (async (
        ...recoverArgs: Parameters<typeof recover>
      ) => {
        const hook = serverHooks.beforeRecovery;
        serverHooks.beforeRecovery = undefined;
        await hook?.();
        return recover(...recoverArgs);
      }) as typeof recover;
      const signOut = client.auth.signOut.bind(client.auth);
      client.auth.signOut = (async (
        ...signOutArgs: Parameters<typeof signOut>
      ) => {
        const replaced = serverHooks.signOutOthers;
        if (signOutArgs[0]?.scope === "others" && replaced) {
          return replaced();
        }
        return signOut(...signOutArgs);
      }) as typeof signOut;
      return client;
    },
  };
});

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

const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

/** The link of the newest email Auth sent to `email` with `subject`. */
async function lastAuthLink(email: string, subject: RegExp) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await (
      await fetch(
        `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
      )
    ).json();
    const found = (list.messages ?? []).find((message: { Subject: string }) =>
      subject.test(message.Subject),
    );
    if (found) {
      const message = await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`)
      ).json();
      const body: string = message.HTML || message.Text;
      return body
        .match(/https?:\/\/[^\s"<>]+\/verify[^\s"<>]+/)![0]
        .replace(/&amp;/g, "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no email");
}

/**
 * She opens the recovery link of her mailbox on this device: Auth's verify
 * endpoint, then our callback (the PKCE code against this device's
 * verifier). Answers where the callback sends her.
 */
async function followRecoveryLink(email: string) {
  const link = await lastAuthLink(email, /mot de passe/i);
  const verified = await fetch(link, { redirect: "manual" });
  const landing = new URL(verified.headers.get("location")!);
  expect(landing.pathname).toBe("/auth/callback");
  const response = await authCallback(new NextRequest(landing));
  return new URL(response.headers.get("location")!).pathname;
}

/** The session id of an access token (its `session_id` claim). */
const sessionOf = (accessToken: string) =>
  JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString())
    .session_id as string;

/** complete_onboarding called straight at the API with `accessToken`. */
async function onboardWithToken(accessToken: string) {
  const response = await fetch(
    `${env.apiUrl}/rest/v1/rpc/complete_onboarding`,
    {
      method: "POST",
      headers: {
        apikey: env.anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_first_name: "Ancien",
        p_last_name: "Jeton",
        p_business_name: "Par un ancien jeton",
        p_slug: uniqueSlug("old"),
      }),
    },
  );
  return { status: response.status, body: await response.json() };
}

async function myBetaAccessWithToken(accessToken: string) {
  const response = await fetch(`${env.apiUrl}/rest/v1/rpc/my_beta_access`, {
    method: "POST",
    headers: {
      apikey: env.anonKey,
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  return response.json();
}

async function businessesOf(userId: string) {
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from public.business_members where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
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
    const [userId] = await accountsFor(email);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        bookingClient().rpc("accept_beta_invitation", {
          p_token_hash: hashInvitationToken(invitation.token),
          p_email: email,
          p_user_id: userId!,
        }),
      ),
    );
    expect(results.map((result) => result.data)).toEqual(
      Array(6).fill("accepted"),
    );
    // For another account than the invited address's: refused.
    const { data: other } = await bookingClient().rpc(
      "accept_beta_invitation",
      {
        p_token_hash: hashInvitationToken(invitation.token),
        p_email: email,
        p_user_id: randomUUID(),
      },
    );
    expect(other).toBe("account_mismatch");
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

    // She opens the link again and signs up again (not confirmed yet): the
    // account may not be hers (nothing proves it), so it is not given yet;
    // a recovery link is sent to her address.
    device = new Device();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await signUpAction({
      email,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    expect(codeOf(again)).toBe("ok");
    expect(await accessOf(userId!)).toBeNull();
    expect(await accountsFor(email)).toEqual([userId]);

    // Her mailbox's link, then her password: her access, her business.
    expect(await followRecoveryLink(email)).toBe("/invitation");
    expect(
      await completeInvitationAction({ password: "Un-autre-mot-de-passe-1" }),
    ).toEqual({ ok: true, data: { next: "/onboarding" } });
    expect(await accessOf(userId!)).toMatchObject({ source: "invitation" });
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
  });

  it("her account existed, confirmed: her password plus her link give access; other sessions end", async () => {
    const email = uniqueEmail("confirmed");
    const invitation = await invite(email);
    await anonClient().auth.signUp({ email, password: PASSWORD });
    await confirmEmail(email);
    // Another session of that account, opened before (another device).
    const elsewhere = anonClient();
    await elsewhere.auth.signInWithPassword({ email, password: PASSWORD });
    const { data: before } = await elsewhere.auth.getSession();

    device = new Device();
    // Signing up again: Auth says the account exists; nothing is given
    // (its password is not proven by a sign-up).
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
    expect(await accessOf(userId!)).toBeNull();

    // She signs in with her password and her link: accepted.
    device = new Device();
    expect(
      await signInAction({
        email,
        password: PASSWORD,
        invitationToken: invitation.token,
      }),
    ).toEqual({
      ok: true,
      data: { next: "/onboarding", invitation: "accepted" },
    });
    expect(await accessOf(userId!)).toMatchObject({ source: "invitation" });
    // The other session is over: its refresh token no longer works.
    const refreshed = await anonClient().auth.refreshSession({
      refresh_token: before.session!.refresh_token,
    });
    expect(refreshed.error).not.toBeNull();
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
  });

  it("signing in with someone else's link gives nothing", async () => {
    const owner = uniqueEmail("link-owner");
    const other = uniqueEmail("link-other");
    const invitation = await invite(owner);
    await admin.auth.admin.createUser({
      email: other,
      password: PASSWORD,
      email_confirm: true,
    });
    device = new Device();
    expect(
      await signInAction({
        email: other,
        password: PASSWORD,
        invitationToken: invitation.token,
      }),
    ).toMatchObject({
      ok: true,
      data: { invitation: "invitation_email_mismatch" },
    });
    const [otherId] = await accountsFor(other);
    expect(await accessOf(otherId!)).toBeNull();
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

describe("beta invitations: an account a third party created first (Codex audit)", () => {
  const THIRD_PARTY = "third-party-password-1";

  it("unconfirmed, made with the invitee's address: after her link and her confirmation, only HER password opens it", async () => {
    const email = uniqueEmail("prey");
    const invitation = await invite(email);
    // A third party creates the account first, straight at Auth.
    const { error } = await anonClient().auth.signUp({
      email,
      password: THIRD_PARTY,
    });
    expect(error).toBeNull();

    // The invitee follows her invitation and signs up: the account is not
    // touched, nothing is given; her mailbox gets a recovery link.
    device = new Device();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const answer = await signUpAction({
      email,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    expect(answer).toEqual({
      ok: true,
      data: { status: "confirmation_required", email, next: null },
    });
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toBeNull();
    expect(adminCalls.updateUserById).toBe(0);

    // Her mailbox's link, on her device: she chooses her password there.
    expect(await followRecoveryLink(email)).toBe("/invitation");
    expect(await completeInvitationAction({ password: PASSWORD })).toEqual({
      ok: true,
      data: { next: "/onboarding" },
    });

    const thirdParty = await anonClient().auth.signInWithPassword({
      email,
      password: THIRD_PARTY,
    });
    expect(thirdParty.error?.message).toMatch(/Invalid login credentials/);
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
    expect(await signInOnNewDevice(email)).toBe("/app");
  });

  it("confirmed with a third party's password: her link gives that account nothing", async () => {
    const email = uniqueEmail("confirmed-prey");
    const invitation = await invite(email);
    await anonClient().auth.signUp({ email, password: THIRD_PARTY });
    // Confirmed (she clicked Auth's own email, sent for the third party).
    await confirmEmail(email);

    device = new Device();
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ),
    ).toBe("email_taken");
    // The third party signs in: no beta access, no business.
    device = new Device();
    const result = await signInAction({ email, password: THIRD_PARTY });
    expect(result.ok).toBe(true);
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe(
      "beta_invitation_required",
    );
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toBeNull();
  });
});

describe("beta invitations: issued again at once, and the service acting for a user (Codex audit)", () => {
  it("re-issued at the same moment: exactly one invitation stays valid for the address", async () => {
    const email = uniqueEmail("reissued");
    const create = (connection: OpenTransaction["connection"], token: string) =>
      connection.query(
        "select public.create_beta_invitation($1, $2, now() + interval '7 days')",
        [email, hashInvitationToken(token)],
      );
    const [first, second] = [
      generateInvitationToken(),
      generateInvitationToken(),
    ];
    // Two operators issue her invitation at once: the first creation is not
    // committed yet when the second runs.
    const one = await openTransaction({ role: "service_role" });
    const two = await openTransaction({ role: "service_role" });
    await create(one.connection, first);
    const pending = outcome(create(two.connection, second));
    await waitUntilBlockedOrDone(two.pid);
    await closeTransaction(one, "commit");
    expect(await pending).toBe("ok");
    await closeTransaction(two, "commit");

    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from private.beta_invitations where email = $1 and revoked_at is null and accepted_at is null",
      [email],
    );
    expect(rows[0]!.n).toBe(1);
    const states = [];
    for (const token of [first, second]) {
      const { data } = await bookingClient().rpc("check_beta_invitation", {
        p_token_hash: hashInvitationToken(token),
        p_email: email,
      });
      states.push(data);
    }
    // The later one wins: the first link no longer works.
    expect(states).toEqual(["invalid", "valid"]);
  });

  it("re-issued many times at once: still exactly one", async () => {
    const email = uniqueEmail("reissued-many");
    await Promise.all(Array.from({ length: 8 }, () => invite(email)));
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from private.beta_invitations where email = $1 and revoked_at is null and accepted_at is null",
      [email],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("a business inserted by the service for a user without access: refused (auth.uid() is null there)", async () => {
    const { data } = await admin.auth.admin.createUser({
      email: uniqueEmail("service-for"),
      password: PASSWORD,
      email_confirm: true,
    });
    const userId = data.user!.id;
    const { error } = await bookingClient()
      .from("businesses")
      .insert({
        name: "Par le service",
        slug: uniqueSlug("svc"),
        contact_email: "svc@test.local",
        timezone: "Europe/Paris",
        created_by: userId,
      } as never);
    expect(error?.message).toBe("beta_invitation_required");
    // Nor without anyone to act for.
    const { error: anonymous } = await bookingClient()
      .from("businesses")
      .insert({
        name: "Sans personne",
        slug: uniqueSlug("svc"),
        contact_email: "svc@test.local",
        timezone: "Europe/Paris",
      } as never);
    expect(anonymous?.message).toBe("beta_invitation_required");

    // For a user who has access: the service may (an operator's tooling).
    const invited = uniqueEmail("service-ok");
    const invitation = await invite(invited);
    device = new Device();
    await signUpAction({
      email: invited,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    await confirmEmail(invited);
    const [invitedId] = await accountsFor(invited);
    const { error: allowed } = await bookingClient()
      .from("businesses")
      .insert({
        name: "Pour une invitée",
        slug: uniqueSlug("svc"),
        contact_email: "svc@test.local",
        timezone: "Europe/Paris",
        created_by: invitedId,
      } as never);
    expect(allowed).toBeNull();
  });

  it("the access counts only once her address is confirmed", async () => {
    const email = uniqueEmail("unproven");
    const invitation = await invite(email);
    device = new Device();
    await signUpAction({
      email,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toMatchObject({ source: "invitation" });
    // A session of hers, opened after the access was given.
    const sessionId = randomUUID();
    await db.query(
      "insert into auth.sessions (id, user_id, created_at, updated_at) values ($1, $2, now(), now())",
      [sessionId, userId],
    );
    const asHer = async () => {
      const transaction = await openTransaction({
        role: "authenticated",
        userId,
        sessionId,
      });
      try {
        const { rows } = await transaction.connection.query<{
          allowed: boolean;
        }>("select public.my_beta_access() as allowed");
        return rows[0]!.allowed;
      } finally {
        await closeTransaction(transaction, "rollback");
      }
    };
    // Even with her JWT (were she able to get one), not yet.
    expect(await asHer()).toBe(false);
    await confirmEmail(email);
    expect(await asHer()).toBe(true);
  });
});

describe("beta invitations: Codex counter-audit", () => {
  const THIRD = "third-party-password-9";

  it("her confirmation lands between two server calls: her link never replaces the account's password", async () => {
    const email = uniqueEmail("between");
    const invitation = await invite(email);
    await anonClient().auth.signUp({ email, password: THIRD });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // The server has seen the account unconfirmed; the real owner confirms
    // her address (Auth's own email, sent for the third party) right then.
    serverHooks.beforeRecovery = () => confirmEmail(email);

    device = new Device();
    const answer = await signUpAction({
      email,
      password: PASSWORD,
      invitationToken: invitation.token,
    });
    expect(codeOf(answer)).toBe("ok");
    expect(serverHooks.beforeRecovery).toBeUndefined();

    // The account is as it was: the third party's password, no access.
    expect(adminCalls.updateUserById).toBe(0);
    const invitee = await anonClient().auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    expect(invitee.error?.message).toMatch(/Invalid login credentials/);
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toBeNull();

    // Only her mailbox's link makes it hers: then the third party's
    // password is refused and the access is hers.
    const thirdSession = await anonClient().auth.signInWithPassword({
      email,
      password: THIRD,
    });
    expect(thirdSession.error).toBeNull();
    expect(await followRecoveryLink(email)).toBe("/invitation");
    expect(codeOf(await completeInvitationAction({ password: PASSWORD }))).toBe(
      "ok",
    );
    expect(
      (await anonClient().auth.signInWithPassword({ email, password: THIRD }))
        .error?.message,
    ).toMatch(/Invalid login credentials/);
    // The third party's session, opened before: ended, and its token
    // activates nothing.
    expect(
      (
        await anonClient().auth.refreshSession({
          refresh_token: thirdSession.data.session!.refresh_token,
        })
      ).error,
    ).not.toBeNull();
    expect(
      (await onboardWithToken(thirdSession.data.session!.access_token)).body
        .message,
    ).toBe("beta_invitation_required");
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
  });

  it("/invitation without her mailbox's link: nothing changes", async () => {
    const email = uniqueEmail("no-proof");
    const invitation = await invite(email);
    await admin.auth.admin.createUser({
      email,
      password: THIRD,
      email_confirm: true,
    });
    // Signed in with the account's password (whoever knows it), her
    // invitation on this device: no proof of the mailbox.
    device = new Device();
    device.set("beta_invitation", invitation.token);
    await signInAction({ email, password: THIRD });
    expect(codeOf(await completeInvitationAction({ password: PASSWORD }))).toBe(
      "invitation_invalid",
    );
    // No invitation on this device: refused too.
    device.delete("beta_invitation");
    expect(codeOf(await completeInvitationAction({ password: PASSWORD }))).toBe(
      "beta_invitation_required",
    );
    const [userId] = await accountsFor(email);
    expect(await accessOf(userId!)).toBeNull();
    expect(
      (
        await anonClient().auth.signInWithPassword({
          email,
          password: PASSWORD,
        })
      ).error?.message,
    ).toMatch(/Invalid login credentials/);
  });

  it("a recovery link followed more than an hour ago is no longer a proof", async () => {
    const email = uniqueEmail("stale-proof");
    const invitation = await invite(email);
    await anonClient().auth.signUp({ email, password: THIRD });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    device = new Device();
    expect(
      codeOf(
        await signUpAction({
          email,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ),
    ).toBe("ok");
    expect(await followRecoveryLink(email)).toBe("/invitation");
    // Two hours later (the device kept the session, refreshed since).
    const [userId] = await accountsFor(email);
    await db.query(
      `update auth.mfa_amr_claims c
       set created_at = c.created_at - interval '2 hours',
           updated_at = c.updated_at - interval '2 hours'
       from auth.sessions s where s.id = c.session_id and s.user_id = $1`,
      [userId],
    );
    const { error } = await (
      await createServerSupabaseClient()
    ).auth.refreshSession();
    expect(error).toBeNull();
    expect(codeOf(await completeInvitationAction({ password: PASSWORD }))).toBe(
      "invitation_invalid",
    );
    expect(await accessOf(userId!)).toBeNull();
    expect(
      (
        await anonClient().auth.signInWithPassword({
          email,
          password: PASSWORD,
        })
      ).error?.message,
    ).toMatch(/Invalid login credentials/);
  });

  it("an earlier session's access token, still valid, cannot activate the beta rights", async () => {
    const email = uniqueEmail("old-token");
    const invitation = await invite(email);
    await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    // Another session of the account, opened before (another device).
    const { data: before } = await anonClient().auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    const oldToken = before.session!.access_token;

    device = new Device();
    expect(
      await signInAction({
        email,
        password: PASSWORD,
        invitationToken: invitation.token,
      }),
    ).toMatchObject({ ok: true, data: { invitation: "accepted" } });

    // That old token is still cryptographically valid (PostgREST accepts
    // it), but it activates nothing, by RPC or otherwise.
    expect(await onboardWithToken(oldToken)).toMatchObject({
      body: { message: "beta_invitation_required" },
    });
    expect(await myBetaAccessWithToken(oldToken)).toBe(false);
    const [userId] = await accountsFor(email);
    expect(await businessesOf(userId!)).toBe(0);

    // A session opened after the proof is allowed (another of her devices),
    // as is the proof's own session.
    const { data: after } = await anonClient().auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    expect(await myBetaAccessWithToken(after.session!.access_token)).toBe(true);
    expect(await getOnboardingStatusAction()).toMatchObject({
      ok: true,
      data: { betaAccess: true },
    });
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
    expect(await businessesOf(userId!)).toBe(1);
  });

  it("the other sessions cannot be ended: an error, nothing given; retried, accepted", async () => {
    const email = uniqueEmail("revoke-fails");
    const invitation = await invite(email);
    await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    const { data: before } = await anonClient().auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    const [userId] = await accountsFor(email);

    serverHooks.signOutOthers = async () => ({
      error: { code: "unexpected_failure" },
    });
    device = new Device();
    try {
      expect(
        codeOf(
          await signInAction({
            email,
            password: PASSWORD,
            invitationToken: invitation.token,
          }),
        ),
      ).toBe("session_revocation_failed");
    } finally {
      serverHooks.signOutOthers = undefined;
    }
    expect(await accessOf(userId!)).toBeNull();
    expect(await onboardWithToken(before.session!.access_token)).toMatchObject({
      body: { message: "beta_invitation_required" },
    });

    // Signing in again, Auth answering: accepted.
    device = new Device();
    expect(
      await signInAction({
        email,
        password: PASSWORD,
        invitationToken: invitation.token,
      }),
    ).toMatchObject({ ok: true, data: { invitation: "accepted" } });
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
  });

  it("Auth says the other sessions ended but kept them: they still activate nothing", async () => {
    const email = uniqueEmail("revoke-lies");
    const invitation = await invite(email);
    await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    const { data: before } = await anonClient().auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    const oldSession = sessionOf(before.session!.access_token);

    serverHooks.signOutOthers = async () => ({ error: null });
    device = new Device();
    try {
      expect(
        await signInAction({
          email,
          password: PASSWORD,
          invitationToken: invitation.token,
        }),
      ).toMatchObject({ ok: true, data: { invitation: "accepted" } });
    } finally {
      serverHooks.signOutOthers = undefined;
    }
    // The old session is alive: refreshed, its new token is still that
    // session's, opened before the proof.
    const { rows } = await db.query(
      "select 1 from auth.sessions where id = $1",
      [oldSession],
    );
    expect(rows).toHaveLength(1);
    const refreshed = await anonClient().auth.refreshSession({
      refresh_token: before.session!.refresh_token,
    });
    expect(refreshed.error).toBeNull();
    const renewed = refreshed.data.session!.access_token;
    expect(sessionOf(renewed)).toBe(oldSession);
    expect(await onboardWithToken(renewed)).toMatchObject({
      body: { message: "beta_invitation_required" },
    });
    expect(await myBetaAccessWithToken(renewed)).toBe(false);
    // Her own session: allowed.
    expect(codeOf(await completeOnboardingAction(onboarding()))).toBe("ok");
  });

  it("the proof is bound to the account: another account's session is refused", async () => {
    const email = uniqueEmail("proof-owner");
    const invitation = await invite(email);
    const { data } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    const other = uniqueEmail("proof-other");
    await admin.auth.admin.createUser({
      email: other,
      password: PASSWORD,
      email_confirm: true,
    });
    const { data: otherSignIn } = await anonClient().auth.signInWithPassword({
      email: other,
      password: PASSWORD,
    });
    const { data: answer } = await bookingClient().rpc(
      "accept_beta_invitation",
      {
        p_token_hash: hashInvitationToken(invitation.token),
        p_email: email,
        p_user_id: data.user!.id,
        p_proof_session: sessionOf(otherSignIn.session!.access_token),
      },
    );
    expect(answer).toBe("account_mismatch");
    expect(await accessOf(data.user!.id)).toBeNull();
  });
});
