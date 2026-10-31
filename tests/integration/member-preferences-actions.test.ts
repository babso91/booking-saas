import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getMyPreferencesAction,
  importDeviceAppearanceAction,
  saveMyPreferencesAction,
} from "@/features/preferences/actions/preferences";
import { deviceCacheOwner } from "@/features/preferences/data/preferences";
import {
  DEVICE_CACHE_COOKIE,
  LEGACY_APPEARANCE_COOKIE,
  parseDeviceCache,
} from "@/features/preferences/device-cache";
import { loadAreaPreferences } from "@/features/preferences/server/area-preferences";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";

import { createBusiness, db, env, type TestBusiness } from "./support/fixtures";

// The Server Actions and the layout's loader, as Next.js runs them, against
// the local database: `next/headers` is the cookie jar of one device
// (Supabase Auth's session cookies included), everything else is real.
// The business always comes from the session; nothing in the input chooses
// whose preferences are read or written.

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
const cookieWrites = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => device.getAll(),
    get: (name: string) => device.get(name),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      cookieWrites(name);
      device.set(name, value, options);
    },
  }),
}));

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

/** Signs `account` in on the current device (session cookies in its jar). */
async function signInHere(account: Account) {
  const client = await createServerSupabaseClient();
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) throw error;
}

async function signOutHere() {
  const client = await createServerSupabaseClient();
  await client.auth.signOut();
}

let izabela: Account;
let marie: Account;
let studioI: TestBusiness;
let studioM: TestBusiness;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  [izabela, marie] = await Promise.all([
    createAccount("act-izabela"),
    createAccount("act-marie"),
  ]);
  studioI = await createBusiness(izabela.userId);
  studioM = await createBusiness(marie.userId);
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
});

describe("preferences actions, on her devices", () => {
  it("first account: the defaults, version 0", async () => {
    device = new Device();
    await signInHere(izabela);
    const read = await getMyPreferencesAction();
    expect(read).toEqual({
      ok: true,
      data: {
        appearance: {
          style: "classique",
          ambiance: "atelier",
          mode: "light",
          accent: null,
          motion: "standard",
        },
        version: 0,
      },
    });
  });

  it("Écrin on the laptop, found on the phone; the phone's colour reaches the laptop", async () => {
    const laptop = new Device();
    device = laptop;
    await signInHere(izabela);
    const saved = await saveMyPreferencesAction({
      expectedVersion: 0,
      changes: { style: "ecrin", mode: "dark" },
    });
    expect(saved).toMatchObject({
      ok: true,
      data: { status: "saved", preferences: { version: 1 } },
    });

    const phone = new Device();
    device = phone;
    await signInHere(izabela);
    const first = await loadAreaPreferences({
      userId: izabela.userId,
      businessId: studioI.id,
    });
    expect(first).toMatchObject({
      source: "account",
      preferences: { appearance: { style: "ecrin", mode: "dark" }, version: 1 },
    });
    const recolored = await saveMyPreferencesAction({
      expectedVersion: 1,
      changes: { accent: "#2f6f5e" },
    });
    expect(recolored).toMatchObject({
      ok: true,
      data: {
        status: "saved",
        preferences: { appearance: { accent: "#2F6F5E" }, version: 2 },
      },
    });

    device = laptop;
    const synced = await getMyPreferencesAction();
    expect(synced).toMatchObject({
      ok: true,
      data: { appearance: { style: "ecrin", accent: "#2F6F5E" }, version: 2 },
    });
  });

  it("each answer leaves this device a cache of HER preferences, rewritten only when it changes", async () => {
    device = new Device();
    await signInHere(izabela);
    cookieWrites.mockClear();
    await getMyPreferencesAction();
    const cached = parseDeviceCache(
      device.get(DEVICE_CACHE_COOKIE)?.value,
      deviceCacheOwner(izabela.userId, studioI.id),
    );
    expect(cached?.version).toBe(2);
    expect(cookieWrites).toHaveBeenCalledWith(DEVICE_CACHE_COOKIE);
    cookieWrites.mockClear();
    await getMyPreferencesAction();
    expect(cookieWrites).not.toHaveBeenCalledWith(DEVICE_CACHE_COOKIE);
  });

  it("a business id sent by the browser is ignored: hers is used", async () => {
    device = new Device();
    await signInHere(izabela);
    const result = await saveMyPreferencesAction({
      expectedVersion: 0,
      changes: { style: "studio" },
      businessId: studioM.id,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
    const { rows } = await db.query(
      "select count(*)::int as count from public.member_preferences where business_id = $1",
      [studioM.id],
    );
    expect(rows[0].count).toBe(0);
  });

  it.each([
    ["no change", { expectedVersion: 2, changes: {} }],
    ["an unknown style", { expectedVersion: 2, changes: { style: "minimal" } }],
    ["CSS as accent", { expectedVersion: 2, changes: { accent: "red;x" } }],
    ["no version", { changes: { style: "studio" } }],
    ["nothing", undefined],
  ])("refuses %s", async (_label, input) => {
    device = new Device();
    await signInHere(izabela);
    const result = await saveMyPreferencesAction(input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
  });

  it("signed out: refused; signed in again: the same preferences", async () => {
    device = new Device();
    await signInHere(izabela);
    await signOutHere();
    expect(await getMyPreferencesAction()).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(
      await saveMyPreferencesAction({
        expectedVersion: 2,
        changes: { motion: "none" },
      }),
    ).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    await signInHere(izabela);
    expect(await getMyPreferencesAction()).toMatchObject({
      ok: true,
      data: { appearance: { style: "ecrin" }, version: 2 },
    });
  });

  it("another professional on the same device: her own preferences, never the cache left by the previous one", async () => {
    device = new Device();
    await signInHere(izabela);
    await getMyPreferencesAction();
    const izabelaCache = device.get(DEVICE_CACHE_COOKIE)?.value;
    await signOutHere();

    await signInHere(marie);
    const area = await loadAreaPreferences({
      userId: marie.userId,
      businessId: studioM.id,
    });
    expect(area).toMatchObject({
      source: "account",
      preferences: { version: 0 },
    });

    // The database away: Izabela's cache is not Marie's.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    const offline = await loadAreaPreferences({
      userId: marie.userId,
      businessId: studioM.id,
    });
    expect(device.get(DEVICE_CACHE_COOKIE)?.value).toBe(izabelaCache);
    expect(offline).toMatchObject({
      source: "default",
      preferences: { version: 0 },
    });
  });

  it("the database away: her own cache is shown; a save fails without writing anything", async () => {
    device = new Device();
    await signInHere(izabela);
    await getMyPreferencesAction();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    const area = await loadAreaPreferences({
      userId: izabela.userId,
      businessId: studioI.id,
    });
    expect(area).toMatchObject({
      source: "device",
      preferences: {
        appearance: { style: "ecrin", accent: "#2F6F5E" },
        version: 2,
      },
    });
    const save = await saveMyPreferencesAction({
      expectedVersion: 2,
      changes: { motion: "none" },
    });
    expect(save.ok).toBe(false);
  });

  it("a malformed device cache is ignored", async () => {
    device = new Device();
    await signInHere(izabela);
    device.set(DEVICE_CACHE_COOKIE, "1.zzz.<script>");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    const area = await loadAreaPreferences({
      userId: izabela.userId,
      businessId: studioI.id,
    });
    expect(area.source).toBe("default");
  });
});

describe("Studio 1's device cookie (dash_appearance)", () => {
  it("is offered, never applied, while her account has nothing; imported only on her word", async () => {
    const fresh = await createAccount("act-fresh");
    const business = await createBusiness(fresh.userId);
    device = new Device();
    device.set(LEGACY_APPEARANCE_COOKIE, "lin.dark.none.97493a.studio");
    await signInHere(fresh);

    const area = await loadAreaPreferences({
      userId: fresh.userId,
      businessId: business.id,
    });
    expect(area).toMatchObject({
      source: "account",
      preferences: { version: 0, appearance: { style: "classique" } },
      deviceAppearanceOffer: {
        style: "studio",
        ambiance: "lin",
        mode: "dark",
        accent: "#97493A",
        motion: "none",
      },
    });

    const imported = await importDeviceAppearanceAction({
      appearance: area.deviceAppearanceOffer,
    });
    expect(imported).toMatchObject({
      ok: true,
      data: {
        status: "saved",
        preferences: { appearance: { style: "studio" }, version: 1 },
      },
    });
    const after = await loadAreaPreferences({
      userId: fresh.userId,
      businessId: business.id,
    });
    expect(after.deviceAppearanceOffer).toBeNull();
  });

  it("a cookie left by another professional never overwrites an account that has preferences", async () => {
    device = new Device();
    device.set(LEGACY_APPEARANCE_COOKIE, "sauge.light.standard.-.classique");
    await signInHere(izabela);
    const area = await loadAreaPreferences({
      userId: izabela.userId,
      businessId: studioI.id,
    });
    expect(area.deviceAppearanceOffer).toBeNull();
    const forced = await importDeviceAppearanceAction({
      appearance: {
        style: "classique",
        ambiance: "sauge",
        mode: "light",
        accent: null,
        motion: "standard",
      },
    });
    expect(forced).toMatchObject({
      ok: true,
      data: {
        status: "stale",
        preferences: { appearance: { style: "ecrin" }, version: 2 },
      },
    });
  });

  it("a malformed cookie offers nothing", async () => {
    const fresh = await createAccount("act-malformed");
    const business = await createBusiness(fresh.userId);
    device = new Device();
    device.set(LEGACY_APPEARANCE_COOKIE, "constructor.dark.none.zzz.studio");
    await signInHere(fresh);
    const area = await loadAreaPreferences({
      userId: fresh.userId,
      businessId: business.id,
    });
    expect(area.deviceAppearanceOffer).toBeNull();
  });
});
