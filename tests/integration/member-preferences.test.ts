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
// and a third member (staff) in A's business. Every UUID is known to all.

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

async function save(
  client: AppSupabaseClient,
  businessId: string,
  expectedVersion: number,
  changes: Changes,
) {
  return client
    .rpc("save_member_preferences", {
      p_business_id: businessId,
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

  it("has exactly the app's closed lists", async () => {
    const { rows } = await db.query(
      "select pg_get_functiondef('private.member_preferences_valid'::regproc) as body",
    );
    const body = rows[0].body as string;
    const list = (parameter: string) =>
      [
        ...new RegExp(`${parameter} in \\(([^)]*)\\)`)
          .exec(body)![1]!
          .matchAll(/'([^']*)'/g),
      ].map((match) => match[1]);
    expect(list("p_style")).toEqual([...preferenceStyles]);
    expect(list("p_ambiance")).toEqual([...preferenceAmbiances]);
    expect(list("p_color_mode")).toEqual([...preferenceModes]);
    expect(list("p_motion")).toEqual([...preferenceMotions]);
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
    ).rejects.toThrow(/member_preferences_values/);
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
        ambiance: "atelier",
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

  it("the service role (the app's server key) has no business here either", async () => {
    const before = await row(businessB.id, bruno.userId);
    const service = bookingClient();
    const writing = await save(service, businessB.id, before.version, {
      style: "studio",
    });
    expect(writing.error).not.toBeNull();
    expect(await row(businessB.id, bruno.userId)).toEqual(before);
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
    const result = await aliceLaptop
      .rpc("save_member_preferences", {
        p_business_id: businessA.id,
        p_expected_version: 0,
        p_changes: changes as never,
      })
      .single();
    expect(result.error?.message).toBe("invalid_preferences");
  });

  it("refuses a missing or negative version", async () => {
    for (const version of [-1, null]) {
      const result = await aliceLaptop
        .rpc("save_member_preferences", {
          p_business_id: businessA.id,
          p_expected_version: version as never,
          p_changes: { style: "studio" },
        })
        .single();
      expect(result.error?.message).toBe("invalid_input");
    }
  });

  it("the table refuses invalid values on every path, the service role's too", async () => {
    await expect(
      db.query(
        `update public.member_preferences set accent = '#zzzzzz'
         where business_id = $1 and user_id = $2`,
        [businessA.id, alice.userId],
      ),
    ).rejects.toThrow(/member_preferences_values/);
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
