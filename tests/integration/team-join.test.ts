import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { GET as authCallback } from "@/app/auth/callback/route";
import { signInAction, signUpAction } from "@/features/auth/actions/auth";
import {
  acceptTeamInviteAction,
  completeTeamInviteAction,
  sendInviteAction,
} from "@/features/team/actions/team";
import {
  generateTeamInviteToken,
  hashTeamInviteToken,
  type TeamDto,
  type TeamMemberDto,
} from "@/features/team/data/team";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  anonClient,
  createBusiness,
  createProfessional,
  db,
  env,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Joining a team (docs/TEAM_CONTRACT.md, « Rejoindre l'équipe »), through
// the actions with a device's cookies, Auth's real emails (Mailpit) and our
// callback. The rule under test: an invitation is never proof that an
// account is hers; only the session that proved it, or a later one,
// reaches the business.

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

const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = "Mot-de-passe-solide-2026";
const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
});

beforeEach(() => {
  process.env.EMAIL_TRANSPORT = "mailpit";
  process.env.EMAIL_FROM = "Equipe <equipe@test.local>";
  process.env.MAILPIT_URL = MAILPIT_URL;
});

const uniqueEmail = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}@test.local`;

type Rpc = { data: unknown; error: { message: string } | null };
const call = (client: AppSupabaseClient, fn: string, args: object) =>
  (client.rpc as unknown as (f: string, a: object) => Promise<Rpc>)(fn, args);

/** The newest email to `email` whose subject matches, as text. */
async function lastEmail(email: string, subject: RegExp): Promise<string> {
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
      return (message.HTML || message.Text) as string;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no email");
}

/** She follows Auth's link: its verify endpoint, then our callback. Answers where she lands. */
async function followAuthLink(email: string, subject: RegExp) {
  const body = await lastEmail(email, subject);
  const link = body
    .match(/https?:\/\/[^\s"<>]+\/verify[^\s"<>]+/)![0]
    .replace(/&amp;/g, "&");
  const verified = await fetch(link, { redirect: "manual" });
  const landing = new URL(verified.headers.get("location")!);
  expect(landing.pathname).toBe("/auth/callback");
  const response = await authCallback(new NextRequest(landing));
  return new URL(response.headers.get("location")!).pathname;
}

async function membershipOf(userId: string) {
  const { rows } = await db.query(
    "select business_id, role from public.business_members where user_id = $1",
    [userId],
  );
  return rows[0] ?? null;
}

let owner: Professional;
let business: TestBusiness;

/** A profile without access, and the owner's device signed in. */
async function newProfile(name: string): Promise<TeamMemberDto> {
  const { data, error } = await call(owner.client, "create_staff_member", {
    p_business_id: business.id,
    p_operation_id: randomUUID(),
    p_display_name: name,
    p_bookable: false,
    p_service_ids: [],
  });
  if (error) throw new Error(error.message);
  return data as TeamMemberDto;
}

/** The owner invites `email` from her screen; answers the link's token, read from the email. */
async function inviteFromScreen(email: string): Promise<string> {
  const member = await newProfile("Invitée");
  device = new Device();
  const signedIn = await signInAction({
    email: owner.email,
    password: owner.password,
  });
  expect(signedIn.ok).toBe(true);
  const sent = await sendInviteAction({
    operationId: randomUUID(),
    staffId: member.id,
    expectedRevision: member.revision,
    email,
    role: "admin",
  });
  if (!sent.ok) throw new Error(sent.error.code);
  const body = await lastEmail(email, /Rejoignez l’équipe/);
  const link = new URL(
    body
      .match(/https?:\/\/[^\s"<>]+\/equipe\/invitation\?token=[^\s"<>]+/)![0]
      .replace(/&amp;/g, "&"),
  );
  return link.searchParams.get("token")!;
}

beforeAll(async () => {
  owner = await createProfessional("join-owner");
  business = await createBusiness(owner.userId);
});

describe("joining a team", () => {
  it("a new person signs up through the email's link, confirms, and joins", async () => {
    const email = uniqueEmail("join-new");
    const token = await inviteFromScreen(email);
    expect(token).toMatch(/^team_/);

    device = new Device();
    const signedUp = await signUpAction({
      email,
      password: PASSWORD,
      firstName: "Nina",
      invitationToken: token,
    });
    expect(signedUp).toEqual({
      ok: true,
      data: { status: "confirmation_required", email, next: null },
    });
    const { rows } = await db.query(
      "select id from auth.users where lower(email) = $1",
      [email],
    );
    const userId = rows[0].id as string;
    expect(await membershipOf(userId)).toBeNull();

    expect(await followAuthLink(email, /confirm/i)).toBe("/equipe/invitation");
    // No token on the page: the one kept on this device by her sign-up.
    const joined = await acceptTeamInviteAction({});
    expect(joined).toEqual({
      ok: true,
      data: { businessId: business.id, next: "/app" },
    });
    expect(await membershipOf(userId)).toEqual({
      business_id: business.id,
      role: "admin",
    });
    expect(device.get("team_invitation")).toBeUndefined();
  });

  it("an existing account joins by signing in with the link; its older sessions are left out", async () => {
    const person = await createProfessional("join-existing");
    const token = await inviteFromScreen(person.email);

    device = new Device();
    const signedIn = await signInAction({
      email: person.email,
      password: person.password,
      invitationToken: token,
    });
    expect(signedIn).toEqual({
      ok: true,
      data: { next: "/app", invitation: "accepted" },
    });
    expect((await membershipOf(person.userId))?.business_id).toBe(business.id);

    // Her session from before (signed out by then, its token still valid
    // until it expires) never reads the business.
    const old = await call(person.client, "get_team", {
      p_business_id: business.id,
    });
    expect(old.error?.message).toBe("forbidden");
    const later = anonClient();
    await later.auth.signInWithPassword({
      email: person.email,
      password: person.password,
    });
    const fresh = await call(later, "get_team", { p_business_id: business.id });
    expect(fresh.error).toBeNull();
    expect((fresh.data as TeamDto).members.length).toBeGreaterThan(1);
  });

  it("an account someone else made first: she sets her own password before joining", async () => {
    const email = uniqueEmail("join-squatted");
    // A third party made the account first, with its own password.
    const squatter = await admin.auth.admin.createUser({
      email,
      password: "Mot-de-passe-du-tiers-1",
      email_confirm: false,
    });
    expect(squatter.error).toBeNull();
    const token = await inviteFromScreen(email);

    device = new Device();
    const signedUp = await signUpAction({
      email,
      password: PASSWORD,
      invitationToken: token,
    });
    expect(signedUp.ok).toBe(true);
    expect(await followAuthLink(email, /mot de passe/i)).toBe(
      "/equipe/invitation",
    );

    // Her recovery session alone is no proof of the password: refused.
    const refused = await acceptTeamInviteAction({});
    expect(refused.ok || refused.error.code).toBe(
      "invitation_password_required",
    );
    expect(await membershipOf(squatter.data.user!.id)).toBeNull();

    const joined = await completeTeamInviteAction({ password: PASSWORD });
    expect(joined).toEqual({
      ok: true,
      data: { businessId: business.id, next: "/app" },
    });
    const third = await anonClient().auth.signInWithPassword({
      email,
      password: "Mot-de-passe-du-tiers-1",
    });
    expect(third.error).not.toBeNull();
  });

  it("records nothing without an email transport", async () => {
    delete process.env.EMAIL_TRANSPORT;
    const member = await newProfile("Sans e-mail");
    device = new Device();
    await signInAction({ email: owner.email, password: owner.password });
    const sent = await sendInviteAction({
      operationId: randomUUID(),
      staffId: member.id,
      expectedRevision: member.revision,
      email: uniqueEmail("join-nomail"),
      role: "admin",
    });
    expect(sent.ok || sent.error.code).toBe("invitation_email_unavailable");
    const { rows } = await db.query(
      "select count(*)::int as n from private.team_invitations where staff_id = $1",
      [member.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("team invitations: database rules", () => {
  it("gives the email only for the token just recorded, and only to the service", async () => {
    const member = await newProfile("Rejeu");
    const operationId = randomUUID();
    const email = uniqueEmail("join-replay");
    const send = (token: string) =>
      call(owner.client, "send_team_invitation", {
        p_business_id: business.id,
        p_operation_id: operationId,
        p_staff_id: member.id,
        p_expected_revision: member.revision,
        p_email: email,
        p_role: "admin",
        p_token_hash: hashTeamInviteToken(token),
      });
    const first = generateTeamInviteToken();
    const replayed = generateTeamInviteToken();
    expect((await send(first)).error).toBeNull();
    expect((await send(replayed)).error).toBeNull();

    const mail = (token: string) =>
      admin.rpc("team_invitation_email", {
        p_token_hash: hashTeamInviteToken(token),
      });
    expect((await mail(first)).data).toEqual([
      expect.objectContaining({ email, role: "admin" }),
    ]);
    expect((await mail(replayed)).data).toEqual([]);

    // Retried after its email failed: the replay's token replaces the
    // pending one, so the email sent now works and the old link does not.
    const rotate = (token: string, op = operationId) =>
      admin.rpc("rotate_team_invitation_token", {
        p_business_id: business.id,
        p_operation_id: op,
        p_token_hash: hashTeamInviteToken(token),
      });
    expect((await rotate(replayed)).data).toBe(true);
    expect((await mail(first)).data).toEqual([]);
    expect((await mail(replayed)).data).toEqual([
      expect.objectContaining({ email }),
    ]);
    expect((await rotate(generateTeamInviteToken(), randomUUID())).data).toBe(
      false,
    );

    for (const fn of [
      "rotate_team_invitation_token",
      "team_invitation_email",
      "team_invited_account",
      "accept_team_invitation_for",
      "record_team_invitation_signup",
    ]) {
      const { error } = await call(owner.client, fn, {});
      expect(error).not.toBeNull();
    }
  });

  it("binds the access to the accepting session, and refuses a stranger's proof session", async () => {
    const member = await newProfile("Preuve");
    const person = await createProfessional("join-proof");
    const token = generateTeamInviteToken();
    const { error } = await call(owner.client, "send_team_invitation", {
      p_business_id: business.id,
      p_operation_id: randomUUID(),
      p_staff_id: member.id,
      p_expected_revision: member.revision,
      p_email: person.email,
      p_role: "admin",
      p_token_hash: hashTeamInviteToken(token),
    });
    expect(error).toBeNull();

    const strangerSession = randomUUID();
    const refused = await admin.rpc("accept_team_invitation_for", {
      p_token_hash: hashTeamInviteToken(token),
      p_email: person.email,
      p_user_id: person.userId,
      p_proof_session: strangerSession,
    });
    expect(refused.error?.message).toBe("invitation_invalid");

    // A session of hers opened before her proof stays outside.
    const before = anonClient();
    await before.auth.signInWithPassword({
      email: person.email,
      password: person.password,
    });
    const accepted = await call(person.client, "accept_team_invitation", {
      p_token_hash: hashTeamInviteToken(token),
    });
    expect(accepted.data).toBe(business.id);
    expect(
      (await call(before, "get_team", { p_business_id: business.id })).error
        ?.message,
    ).toBe("forbidden");
    expect(
      (await call(person.client, "get_team", { p_business_id: business.id }))
        .error,
    ).toBeNull();
  });
});
