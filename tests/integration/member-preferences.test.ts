import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  defaultAppearancePreferences,
  preferenceAmbiances,
  preferenceModes,
  preferenceMotions,
  preferenceStyles,
} from "@/features/preferences/model";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

import {
  anonClient,
  bookingClient,
  createBusiness,
  db,
  env,
  type TestBusiness,
} from "./support/fixtures";

// A professional's personal preferences (public.member_preferences), through
// PostgREST with real Supabase Auth sessions: the path a browser, or an
// attacker with her own account, takes. Two professionals, two businesses,
// and a third member (admin) in A's business. Every UUID is known to all.

const admin = createClient<Database>(env.apiUrl, env.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Account = { userId: string; email: string; password: string };

async function createAccount(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("user");
  return { userId: data.user.id, email, password };
}

/** A new sign-in: another device, its own session. */
async function signIn(account: Account): Promise<AppSupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) throw error;
  return client;
}

type Changes = Record<string, unknown>;

async function membershipOf(businessId: string, userId: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.business_members where business_id = $1 and user_id = $2",
    [businessId, userId],
  );
  return rows[0]?.id ?? null;
}

async function incarnationOf(businessId: string, userId: string) {
  const { rows } = await db.query<{ incarnation: string }>(
    "select incarnation from public.member_preferences where business_id = $1 and user_id = $2",
    [businessId, userId],
  );
  return rows[0]?.incarnation ?? null;
}

/**
 * save_member_preferences as a device calls it: for the caller's
 * membership, and (unless given) the row's current incarnation as the
 * expected one, so that `expectedVersion` alone says what the device read.
 */
async function save(
  client: AppSupabaseClient,
  businessId: string,
  expectedVersion: number,
  changes: Changes,
  overrides: { membershipId?: string; incarnation?: string | null } = {},
) {
  const userId = (await client.auth.getSession()).data.session?.user.id;
  const membershipId =
    overrides.membershipId ??
    (userId ? await membershipOf(businessId, userId) : null) ??
    randomUUID();
  const incarnation =
    "incarnation" in overrides
      ? overrides.incarnation
      : expectedVersion === 0
        ? null
        : ((userId ? await incarnationOf(businessId, userId) : null) ??
          randomUUID());
  return client
    .rpc("save_member_preferences", {
      p_business_id: businessId,
      p_membership_id: membershipId,
      p_expected_incarnation: incarnation as string,
      p_expected_version: expectedVersion,
      p_changes: changes as never,
    })
    .single();
}

async function read(client: AppSupabaseClient, businessId: string) {
  return client
    .from("member_preferences")
    .select("user_id, style, ambiance, color_mode, accent, motion, version")
    .eq("business_id", businessId);
}

async function row(businessId: string, userId: string) {
  const { rows } = await db.query(
    `select style, ambiance, color_mode, accent, motion, version::int
     from public.member_preferences where business_id = $1 and user_id = $2`,
    [businessId, userId],
  );
  return rows[0] ?? null;
}

let alice: Account;
let bruno: Account;
let staff: Account;
let aliceLaptop: AppSupabaseClient;
let brunoClient: AppSupabaseClient;
let staffClient: AppSupabaseClient;
let businessA: TestBusiness;
let businessB: TestBusiness;

beforeAll(async () => {
  [alice, bruno, staff] = await Promise.all([
    createAccount("pref-alice"),
    createAccount("pref-bruno"),
    createAccount("pref-staff"),
  ]);
  businessA = await createBusiness(alice.userId);
  businessB = await createBusiness(bruno.userId);
  await db.query(
    `insert into public.business_members (business_id, user_id, role)
     values ($1, $2, 'admin')`,
    [businessA.id, staff.userId],
  );
  [aliceLaptop, brunoClient, staffClient] = await Promise.all([
    signIn(alice),
    signIn(bruno),
    signIn(staff),
  ]);
});

describe("defaults and the closed lists", () => {
  it("a member without preferences reads nothing (the defaults, version 0)", async () => {
    const { data, error } = await read(staffClient, businessA.id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("the table's defaults are the app's defaults", async () => {
    const business = await createBusiness(
      (await createAccount("pref-d")).userId,
    );
    const { rows } = await db.query(
      `insert into public.member_preferences (business_id, user_id)
       select business_id, user_id from public.business_members where business_id = $1
       returning style, ambiance, color_mode, accent, motion, version::int`,
      [business.id],
    );
    expect(rows[0]).toEqual({
      style: defaultAppearancePreferences.style,
      ambiance: defaultAppearancePreferences.ambiance,
      color_mode: defaultAppearancePreferences.mode,
      accent: defaultAppearancePreferences.accent,
      motion: defaultAppearancePreferences.motion,
      version: 1,
    });
  });

  it("has exactly the app's closed lists (one domain per field)", async () => {
    const list = async (domain: string) => {
      const { rows } = await db.query(
        `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c where c.contypid = $1::regtype`,
        [`public.${domain}`],
      );
      return [...(rows[0].def as string).matchAll(/'([^']*)'/g)].map(
        (match) => match[1],
      );
    };
    expect(await list("member_preference_style")).toEqual([
      ...preferenceStyles,
    ]);
    expect(await list("member_preference_ambiance")).toEqual([
      ...preferenceAmbiances,
    ]);
    expect(await list("member_preference_color_mode")).toEqual([
      ...preferenceModes,
    ]);
    expect(await list("member_preference_motion")).toEqual([
      ...preferenceMotions,
    ]);
  });

  it.each([
    ["style", "Studio"],
    ["style", "minimal"],
    ["style", ""],
    ["ambiance", "constructor"],
    ["color_mode", "auto"],
    ["motion", "fast"],
  ])("the table refuses %s = %j", async (column, value) => {
    const business = await createBusiness(
      (await createAccount("pref-v")).userId,
    );
    await expect(
      db.query(
        `insert into public.member_preferences (business_id, user_id, ${column})
         select business_id, user_id, $2 from public.business_members where business_id = $1`,
        [business.id, value],
      ),
    ).rejects.toThrow(/member_preference_/);
  });
});

describe("her own preferences, saved and read again elsewhere", () => {
  it("Écrin on her laptop, found on her phone; a colour changed on the phone reaches the laptop", async () => {
    const laptop = aliceLaptop;
    const first = await save(laptop, businessA.id, 0, {
      style: "ecrin",
      color_mode: "dark",
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      status: "saved",
      style: "ecrin",
      color_mode: "dark",
      accent: null,
      version: 1,
    });

    const phone = await signIn(alice);
    const onPhone = await read(phone, businessA.id);
    expect(onPhone.data).toEqual([
      {
        user_id: alice.userId,
        style: "ecrin",
        ambiance: "egyptien",
        color_mode: "dark",
        accent: null,
        motion: "standard",
        version: 1,
      },
    ]);

    const recolored = await save(phone, businessA.id, 1, { accent: "#2F6F5E" });
    expect(recolored.data).toMatchObject({ status: "saved", version: 2 });

    const onLaptop = await read(laptop, businessA.id);
    expect(onLaptop.data?.[0]).toMatchObject({
      style: "ecrin",
      color_mode: "dark",
      accent: "#2F6F5E",
      version: 2,
    });
  });

  it("signed out then in again: the same preferences; signed out, nothing", async () => {
    const device = await signIn(alice);
    await device.auth.signOut();
    const afterSignOut = await read(device, businessA.id);
    expect(afterSignOut.data ?? []).toEqual([]);
    const denied = await save(device, businessA.id, 2, { motion: "none" });
    expect(denied.error).not.toBeNull();

    const again = await signIn(alice);
    const { data } = await read(again, businessA.id);
    expect(data?.[0]).toMatchObject({ style: "ecrin", accent: "#2F6F5E" });
  });

  it("a retried save (lost answer) is 'unchanged', whatever version it carries", async () => {
    const before = await row(businessA.id, alice.userId);
    const retry = await save(aliceLaptop, businessA.id, 1, {
      accent: "#2F6F5E",
    });
    expect(retry.data).toMatchObject({
      status: "unchanged",
      version: before.version,
    });
    expect(await row(businessA.id, alice.userId)).toEqual(before);
  });

  it("a save on an old version of a field that changed since is 'stale': nothing written, the account's state answered", async () => {
    const before = await row(businessA.id, alice.userId);
    const stale = await save(aliceLaptop, businessA.id, 1, {
      accent: "#112233",
    });
    expect(stale.error).toBeNull();
    expect(stale.data).toMatchObject({
      status: "stale",
      accent: "#2F6F5E",
      version: before.version,
    });
    expect(await row(businessA.id, alice.userId)).toEqual(before);
  });

  it("an accent can be cleared (null), and is a change", async () => {
    const before = await row(businessA.id, alice.userId);
    const cleared = await save(aliceLaptop, businessA.id, before.version, {
      accent: null,
    });
    expect(cleared.data).toMatchObject({
      status: "saved",
      accent: null,
      version: before.version + 1,
    });
  });
});

describe("isolation between accounts", () => {
  beforeAll(async () => {
    const saved = await save(brunoClient, businessB.id, 0, {
      style: "carnet",
      accent: "#ABCDEF",
    });
    expect(saved.data).toMatchObject({ status: "saved" });
  });

  it("nobody reads another account's preferences: not another business, not her own business's owner", async () => {
    const fromAlice = await read(aliceLaptop, businessB.id);
    expect(fromAlice.data).toEqual([]);
    const all = await aliceLaptop
      .from("member_preferences")
      .select("user_id, business_id");
    expect(all.data?.every((r) => r.user_id === alice.userId)).toBe(true);

    await save(staffClient, businessA.id, 0, { style: "studio" });
    const ownerReadsStaff = await aliceLaptop
      .from("member_preferences")
      .select("user_id")
      .eq("user_id", staff.userId);
    expect(ownerReadsStaff.data).toEqual([]);
    const staffReadsOwner = await staffClient
      .from("member_preferences")
      .select("user_id")
      .eq("user_id", alice.userId);
    expect(staffReadsOwner.data).toEqual([]);
  });

  it("a business id that is not hers is refused, and writes nothing", async () => {
    const before = await row(businessB.id, bruno.userId);
    const forged = await save(aliceLaptop, businessB.id, before.version, {
      style: "classique",
    });
    expect(forged.error?.message).toBe("forbidden");
    const unknown = await save(aliceLaptop, randomUUID(), 0, {
      style: "studio",
    });
    expect(unknown.error?.message).toBe("forbidden");
    expect(await row(businessB.id, bruno.userId)).toEqual(before);
    expect(await row(businessB.id, alice.userId)).toBeNull();
  });

  it("no direct insert, update or delete, for anyone, on anyone's row", async () => {
    const before = await row(businessB.id, bruno.userId);
    const insert = await aliceLaptop.from("member_preferences").insert({
      business_id: businessB.id,
      user_id: bruno.userId,
      style: "studio",
    });
    expect(insert.error?.code).toBe("42501");

    for (const client of [aliceLaptop, brunoClient]) {
      const update = await client
        .from("member_preferences")
        .update({ style: "studio", version: 999 })
        .eq("business_id", businessB.id);
      expect(update.error?.code).toBe("42501");
      const remove = await client
        .from("member_preferences")
        .delete()
        .eq("business_id", businessB.id);
      expect(remove.error?.code).toBe("42501");
    }
    expect(await row(businessB.id, bruno.userId)).toEqual(before);
  });

  it("the anonymous key reads nothing and cannot save", async () => {
    const anon = anonClient();
    const reading = await anon.from("member_preferences").select("*");
    expect(reading.error?.code).toBe("42501");
    const writing = await save(anon, businessB.id, 0, { style: "studio" });
    expect(writing.error).not.toBeNull();
  });

  it("the API roles: anon has nothing, authenticated only SELECT (RLS); the service role keeps its administrative rights", async () => {
    const { rows } = await db.query(
      `select grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
       from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'member_preferences'
         and grantee in ('anon', 'authenticated', 'service_role')
       group by grantee order by grantee`,
    );
    expect(rows).toEqual([
      { grantee: "authenticated", privileges: "SELECT" },
      {
        grantee: "service_role",
        privileges: "DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE",
      },
    ]);
    const bypass = await db.query(
      "select rolbypassrls from pg_roles where rolname = 'service_role'",
    );
    expect(bypass.rows[0].rolbypassrls).toBe(true);
  });

  it("the service role reads and writes rows directly (administration), still under the table's rules; the RPC refuses it (no user)", async () => {
    const service = bookingClient();
    const all = await service
      .from("member_preferences")
      .select("user_id")
      .in("business_id", [businessA.id, businessB.id]);
    expect(all.error).toBeNull();
    expect(new Set(all.data!.map((r) => r.user_id))).toContain(bruno.userId);
    expect(new Set(all.data!.map((r) => r.user_id))).toContain(alice.userId);

    const before = await row(businessB.id, bruno.userId);
    const incarnation = await incarnationOf(businessB.id, bruno.userId);
    // Its direct write is a real write: version moved by the trigger, the
    // version and incarnation it sends are ignored.
    const update = await service
      .from("member_preferences")
      .update({ motion: "discrete", version: 999, incarnation: randomUUID() })
      .eq("business_id", businessB.id)
      .eq("user_id", bruno.userId);
    expect(update.error).toBeNull();
    expect(await row(businessB.id, bruno.userId)).toEqual({
      ...before,
      motion: "discrete",
      version: before.version + 1,
    });
    expect(await incarnationOf(businessB.id, bruno.userId)).toBe(incarnation);
    // Never outside the closed lists, never for a non-member.
    const invalid = await service
      .from("member_preferences")
      .update({ style: "minimal" })
      .eq("business_id", businessB.id);
    expect(invalid.error?.code).toBe("23514");
    const stranger = await service.from("member_preferences").insert({
      business_id: businessB.id,
      user_id: alice.userId,
    });
    expect(stranger.error?.code).toBe("23503");
    // The RPC acts for a signed-in member only.
    const rpc = await save(service, businessB.id, before.version + 1, {
      style: "studio",
    });
    expect(rpc.error?.message).toBe("unauthenticated");
    expect((await row(businessB.id, bruno.userId)).style).toBe(before.style);
  });

  it("a member removed from the business loses her preferences there, and can no longer save", async () => {
    const leaver = await createAccount("pref-leaver");
    await db.query(
      `insert into public.business_members (business_id, user_id, role)
       values ($1, $2, 'admin')`,
      [businessA.id, leaver.userId],
    );
    const client = await signIn(leaver);
    await save(client, businessA.id, 0, { motion: "none" });
    expect(await row(businessA.id, leaver.userId)).not.toBeNull();

    await db.query(
      "delete from public.business_members where business_id = $1 and user_id = $2",
      [businessA.id, leaver.userId],
    );
    expect(await row(businessA.id, leaver.userId)).toBeNull();
    const denied = await save(client, businessA.id, 0, { motion: "none" });
    expect(denied.error?.message).toBe("forbidden");
  });

  it("the same professional in two businesses has two independent rows", async () => {
    const both = await createAccount("pref-both");
    const first = await createBusiness(both.userId);
    const second = await createBusiness(both.userId);
    const client = await signIn(both);
    await save(client, first.id, 0, { style: "studio" });
    await save(client, second.id, 0, { style: "carnet" });
    expect((await row(first.id, both.userId)).style).toBe("studio");
    expect((await row(second.id, both.userId)).style).toBe("carnet");
  });
});

describe("validation and injection", () => {
  it.each([
    ["an unknown field", { theme: "dark" }],
    ["user_id smuggled in", { user_id: randomUUID() }],
    ["business_id smuggled in", { business_id: randomUUID() }],
    ["version smuggled in", { version: 99 }],
    ["a number", { style: 1 }],
    ["an object", { style: { $ne: null } }],
    ["an array", { accent: ["#FFFFFF"] }],
    ["null where a value is required", { style: null }],
    ["an unknown style", { style: "minimal" }],
    ["a style in capitals", { style: "Studio" }],
    [
      "SQL in a value",
      { style: "classique'; drop table public.member_preferences; --" },
    ],
    ["an accent without #", { accent: "97493A" }],
    ["an accent in lowercase", { accent: "#97493a" }],
    ["a CSS payload as accent", { accent: "#000000;}body{display:none" }],
    ["an accent with a newline", { accent: "#97493A\n" }],
    ["a prototype key", { __proto__: { style: "studio" }, constructor: "x" }],
  ])("refuses %s, and writes nothing", async (_label, changes) => {
    const before = await row(businessA.id, alice.userId);
    const result = await save(
      aliceLaptop,
      businessA.id,
      before.version,
      changes,
    );
    expect(result.error?.message).toBe("invalid_preferences");
    expect(await row(businessA.id, alice.userId)).toEqual(before);
  });

  it.each([
    ["not an object", ["style", "studio"]],
    ["a string", "studio"],
    ["null", null],
  ])("refuses a patch that is %s", async (_label, changes) => {
    const result = await save(aliceLaptop, businessA.id, 0, changes as never);
    expect(result.error?.message).toBe("invalid_preferences");
  });

  it("refuses a missing or negative version, or an incoherent expected state", async () => {
    const incarnation = await incarnationOf(businessA.id, alice.userId);
    for (const [version, expected] of [
      [-1, incarnation],
      [null, incarnation],
      [0, incarnation],
      [3, null],
    ] as const) {
      const result = await save(
        aliceLaptop,
        businessA.id,
        version as never,
        { style: "studio" },
        { incarnation: expected },
      );
      expect(result.error?.message).toBe("invalid_input");
    }
    const noMembership = await aliceLaptop
      .rpc("save_member_preferences", {
        p_business_id: businessA.id,
        p_membership_id: null as never,
        p_expected_incarnation: null as never,
        p_expected_version: 0,
        p_changes: { style: "studio" },
      })
      .single();
    expect(noMembership.error?.message).toBe("invalid_input");
  });

  it("the table refuses invalid values on every path, the service role's too", async () => {
    await expect(
      db.query(
        `update public.member_preferences set accent = '#zzzzzz'
         where business_id = $1 and user_id = $2`,
        [businessA.id, alice.userId],
      ),
    ).rejects.toThrow(/member_preference_accent/);
  });
});

describe("version and concurrency", () => {
  it("the version is the database's: a direct write cannot set it, and only a real change moves it", async () => {
    const before = await row(businessA.id, alice.userId);
    await db.query(
      `update public.member_preferences set version = 1000, style = style
       where business_id = $1 and user_id = $2`,
      [businessA.id, alice.userId],
    );
    expect((await row(businessA.id, alice.userId)).version).toBe(
      before.version,
    );
    await db.query(
      `update public.member_preferences set version = 1000, motion = 'discrete'
       where business_id = $1 and user_id = $2`,
      [businessA.id, alice.userId],
    );
    expect((await row(businessA.id, alice.userId)).version).toBe(
      before.version + 1,
    );
  });

  it("the member and business of a row never change", async () => {
    await expect(
      db.query(
        `update public.member_preferences set user_id = $3
         where business_id = $1 and user_id = $2`,
        [businessA.id, alice.userId, staff.userId],
      ),
    ).rejects.toThrow(/forbidden/);
  });

  it("eight devices save different colours on the same version at once: exactly one is saved, the others are stale", async () => {
    const devices = await Promise.all(
      Array.from({ length: 8 }, () => signIn(alice)),
    );
    const before = await row(businessA.id, alice.userId);
    const colours = devices.map((_, index) => `#00000${index}`);
    const answers = await Promise.all(
      devices.map((device, index) =>
        save(device, businessA.id, before.version, { accent: colours[index] }),
      ),
    );
    const statuses = answers.map((answer) => answer.data?.status);
    expect(statuses.filter((status) => status === "saved")).toHaveLength(1);
    expect(statuses.filter((status) => status === "stale")).toHaveLength(7);
    const after = await row(businessA.id, alice.userId);
    expect(after.version).toBe(before.version + 1);
    const winner = answers.find((answer) => answer.data?.status === "saved")!;
    expect(after.accent).toBe(winner.data!.accent);
    for (const answer of answers) {
      // Every answer, stale or not, carries a state of the account.
      expect(answer.data!.version).toBeGreaterThanOrEqual(before.version);
    }
  });

  it("a first save from two devices at once: one creates the row, the other is stale (or unchanged if equal)", async () => {
    const fresh = await createAccount("pref-race");
    const business = await createBusiness(fresh.userId);
    const [one, two, three] = await Promise.all([
      signIn(fresh),
      signIn(fresh),
      signIn(fresh),
    ]);
    const answers = await Promise.all([
      save(one, business.id, 0, { style: "studio" }),
      save(two, business.id, 0, { style: "ecrin" }),
      save(three, business.id, 0, { style: "studio" }),
    ]);
    for (const answer of answers) expect(answer.error).toBeNull();
    const statuses = answers.map((answer) => answer.data!.status);
    expect(statuses.filter((status) => status === "saved")).toHaveLength(1);
    const stored = await row(business.id, fresh.userId);
    expect(stored.version).toBe(1);
    answers.forEach((answer, index) => {
      const wanted = index === 1 ? "ecrin" : "studio";
      if (answer.data!.status === "saved") expect(stored.style).toBe(wanted);
      else
        expect(answer.data!.status).toBe(
          stored.style === wanted ? "unchanged" : "stale",
        );
    });
  });

  it("two devices changing different fields: both land, one after re-applying on the new version", async () => {
    const before = await row(businessA.id, alice.userId);
    const [laptop, phone] = await Promise.all([signIn(alice), signIn(alice)]);
    const fromLaptop = await save(laptop, businessA.id, before.version, {
      color_mode: "system",
    });
    expect(fromLaptop.data!.status).toBe("saved");
    const fromPhone = await save(phone, businessA.id, before.version, {
      ambiance: "sauge",
    });
    expect(fromPhone.data).toMatchObject({
      status: "stale",
      color_mode: "system",
    });
    const again = await save(phone, businessA.id, fromPhone.data!.version, {
      ambiance: "sauge",
    });
    expect(again.data).toMatchObject({
      status: "saved",
      color_mode: "system",
      ambiance: "sauge",
      version: before.version + 2,
    });
  });
});

describe("reading, through read_member_preferences", () => {
  it("answers her membership and her row, or the defaults (no incarnation, version 0)", async () => {
    const reader = await createAccount("pref-reader");
    const business = await createBusiness(reader.userId);
    const client = await signIn(reader);
    const empty = await client
      .rpc("read_member_preferences", { p_business_id: business.id })
      .single();
    expect(empty.data).toEqual({
      membership_id: await membershipOf(business.id, reader.userId),
      incarnation: null,
      style: "classique",
      ambiance: "egyptien",
      color_mode: "light",
      accent: null,
      motion: "standard",
      version: 0,
    });
    await save(client, business.id, 0, { style: "studio" });
    const saved = await client
      .rpc("read_member_preferences", { p_business_id: business.id })
      .single();
    expect(saved.data).toMatchObject({
      incarnation: await incarnationOf(business.id, reader.userId),
      style: "studio",
      version: 1,
    });
  });

  it("a member without a row reads the defaults, never another member's row of the same business", async () => {
    const newcomer = await createAccount("pref-newcomer");
    await db.query(
      `insert into public.business_members (business_id, user_id, role)
       values ($1, $2, 'admin')`,
      [businessA.id, newcomer.userId],
    );
    expect(await row(businessA.id, alice.userId)).not.toBeNull();
    const client = await signIn(newcomer);
    const read = await client
      .rpc("read_member_preferences", { p_business_id: businessA.id })
      .single();
    expect(read.data).toMatchObject({
      membership_id: await membershipOf(businessA.id, newcomer.userId),
      incarnation: null,
      style: "classique",
      accent: null,
      version: 0,
    });
  });

  it("refuses another business, the anonymous key and the service role", async () => {
    const other = await aliceLaptop
      .rpc("read_member_preferences", { p_business_id: businessB.id })
      .single();
    expect(other.error?.message).toBe("forbidden");
    const anon = await anonClient()
      .rpc("read_member_preferences", { p_business_id: businessB.id })
      .single();
    expect(anon.error).not.toBeNull();
    const service = await bookingClient()
      .rpc("read_member_preferences", { p_business_id: businessB.id })
      .single();
    expect(service.error).not.toBeNull();
  });
});

describe("contexts and incarnations", () => {
  it("a save for another membership than hers (stale page) is context_changed, and writes nothing", async () => {
    const before = await row(businessA.id, alice.userId);
    const result = await save(
      aliceLaptop,
      businessA.id,
      before.version,
      { style: "carnet" },
      { membershipId: randomUUID() },
    );
    expect(result.error?.message).toBe("context_changed");
    expect(await row(businessA.id, alice.userId)).toEqual(before);
  });

  it("the incarnation is fixed for a row's life, and new when the row is created again", async () => {
    const owner = await createAccount("pref-inc");
    const business = await createBusiness(owner.userId);
    const client = await signIn(owner);
    const first = await save(client, business.id, 0, { style: "studio" });
    const incarnation = first.data!.incarnation;
    expect(incarnation).toMatch(/^[0-9a-f-]{36}$/);
    const second = await save(client, business.id, 1, { style: "ecrin" });
    expect(second.data).toMatchObject({ incarnation, version: 2 });
    await expect(
      db.query(
        "update public.member_preferences set incarnation = gen_random_uuid() where business_id = $1",
        [business.id],
      ),
    ).resolves.toBeTruthy();
    expect(await incarnationOf(business.id, owner.userId)).toBe(incarnation);

    // An administrator deletes the row; a device still at version 2 of the
    // old incarnation is stale (not applied on the new state), then saves.
    await db.query(
      "delete from public.member_preferences where business_id = $1",
      [business.id],
    );
    const stale = await save(
      client,
      business.id,
      2,
      { motion: "none" },
      { incarnation },
    );
    expect(stale.data).toMatchObject({
      status: "stale",
      incarnation: null,
      version: 0,
    });
    const recreated = await save(client, business.id, 0, { motion: "none" });
    expect(recreated.data).toMatchObject({ status: "saved", version: 1 });
    expect(recreated.data!.incarnation).not.toBe(incarnation);
    // The old incarnation at the new row's version is stale too.
    const crossed = await save(
      client,
      business.id,
      1,
      { motion: "discrete" },
      { incarnation },
    );
    expect(crossed.data).toMatchObject({ status: "stale", version: 1 });
  });

  it("leaving and joining again, three times: a new context each time; the old one writes nothing; saving works from version 0", async () => {
    const member = await createAccount("pref-rejoin");
    const business = await createBusiness(
      (await createAccount("pref-rejoin-owner")).userId,
    );
    const client = await signIn(member);
    const memberships: string[] = [];
    const incarnations: string[] = [];
    let previous: { membershipId: string; incarnation: string } | null = null;
    for (let cycle = 0; cycle < 3; cycle++) {
      await db.query(
        `insert into public.business_members (business_id, user_id, role)
         values ($1, $2, 'admin')`,
        [business.id, member.userId],
      );
      const read = await client
        .rpc("read_member_preferences", { p_business_id: business.id })
        .single();
      expect(read.data).toMatchObject({ incarnation: null, version: 0 });
      memberships.push(read.data!.membership_id);

      if (previous) {
        // A device still in the previous membership: refused.
        const old = await save(
          client,
          business.id,
          3,
          { style: "carnet" },
          {
            membershipId: previous.membershipId,
            incarnation: previous.incarnation,
          },
        );
        expect(old.error?.message).toBe("context_changed");
        // The new membership, but the old row's state: stale, not applied.
        const crossed = await save(
          client,
          business.id,
          3,
          { style: "carnet" },
          {
            incarnation: previous.incarnation,
          },
        );
        expect(crossed.data).toMatchObject({ status: "stale", version: 0 });
      }
      expect(await row(business.id, member.userId)).toBeNull();

      let version = 0;
      for (const accent of ["#000001", "#000002", "#000003"]) {
        const saved = await save(client, business.id, version, { accent });
        expect(saved.data).toMatchObject({
          status: "saved",
          version: version + 1,
          membership_id: read.data!.membership_id,
        });
        version = saved.data!.version;
      }
      const incarnation = (await incarnationOf(business.id, member.userId))!;
      incarnations.push(incarnation);
      previous = { membershipId: read.data!.membership_id, incarnation };

      await db.query(
        "delete from public.business_members where business_id = $1 and user_id = $2",
        [business.id, member.userId],
      );
      expect(await row(business.id, member.userId)).toBeNull();
    }
    expect(new Set(memberships).size).toBe(3);
    expect(new Set(incarnations).size).toBe(3);
  });
});
