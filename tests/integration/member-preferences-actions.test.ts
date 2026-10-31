import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getMyPreferencesAction,
  importDeviceAppearanceAction,
  saveMyPreferencesAction,
} from "@/features/preferences/actions/preferences";
import {
  changeLocally,
  displayedAppearance,
  enterContext,
  initialSyncState,
  nextSave,
  readAnswered,
  saveAnswered,
  saveFailed,
  startRead,
  type SaveRequest,
  type SyncState,
} from "@/features/preferences/client/preference-sync";
import { deviceCacheOwner } from "@/features/preferences/data/preferences";
import {
  DEVICE_CACHE_COOKIE,
  LEGACY_APPEARANCE_COOKIE,
  parseDeviceCache,
} from "@/features/preferences/device-cache";
import {
  defaultAppearancePreferences,
  type AppearancePreferences,
} from "@/features/preferences/model";
import { loadAreaPreferences } from "@/features/preferences/server/area-preferences";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";

import { createBusiness, db, env, type TestBusiness } from "./support/fixtures";

// The Server Actions and the layout's loader, as Next.js runs them, against
// the local database: `next/headers` is the cookie jar of one device
// (Supabase Auth's session cookies included), everything else is real.
// The business always comes from the session; nothing in the input chooses
// whose preferences are read or written. The device's sync state machine
// (preference-sync.ts) is driven by the real answers, as the provider will.

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

const look = (patch: Partial<AppearancePreferences> = {}) => ({
  ...defaultAppearancePreferences,
  ...patch,
});

/** The layout's render of the area for `account` in `businessId`: its state. */
async function enterArea(
  account: Account,
  businessId: string,
  previous?: SyncState,
) {
  const area = await loadAreaPreferences({
    userId: account.userId,
    businessId,
  });
  expect(area.source).toBe("account");
  return previous
    ? enterContext(previous, area.snapshot!)
    : initialSyncState(area.snapshot!);
}

/** Sends a save with the real action. */
async function sendSave(request: SaveRequest) {
  return saveMyPreferencesAction({
    context: {
      businessId: request.context.businessId,
      membershipId: request.context.membershipId,
    },
    expected: request.expected,
    changes: request.changes,
  });
}

/** Applies a save's real result, as the provider does. */
function answer(
  state: SyncState,
  request: SaveRequest,
  result: Awaited<ReturnType<typeof saveMyPreferencesAction>>,
) {
  if (result.ok) return saveAnswered(state, request.ticket, result.data);
  return saveFailed(
    state,
    request.ticket,
    ["context_changed", "unauthenticated", "forbidden", "no_business"].includes(
      result.error.code,
    )
      ? "context_changed"
      : "network",
  );
}

/** Saves until the device is in step (or paused). */
async function sync(state: SyncState) {
  for (let round = 0; round < 10; round++) {
    const [sending, request] = nextSave(state);
    if (!request) return sending;
    state = answer(sending, request, await sendSave(request));
  }
  throw new Error("never settles");
}

async function readAgain(state: SyncState) {
  const [reading, ticket] = startRead(state);
  const result = await getMyPreferencesAction();
  if (!result.ok) throw new Error(result.error.code);
  return readAnswered(reading, ticket, result.data);
}

async function rowOf(businessId: string, userId: string) {
  const { rows } = await db.query(
    `select style, accent, motion, version::int, incarnation
     from public.member_preferences where business_id = $1 and user_id = $2`,
    [businessId, userId],
  );
  return rows[0] ?? null;
}

describe("preferences actions, on her devices", () => {
  it("first account: the defaults, version 0, for her membership", async () => {
    device = new Device();
    await signInHere(izabela);
    const read = await getMyPreferencesAction();
    const { rows } = await db.query(
      "select id from public.business_members where business_id = $1 and user_id = $2",
      [studioI.id, izabela.userId],
    );
    expect(read).toEqual({
      ok: true,
      data: {
        context: {
          userId: izabela.userId,
          businessId: studioI.id,
          membershipId: rows[0].id,
        },
        preferences: {
          appearance: defaultAppearancePreferences,
          incarnation: null,
          version: 0,
        },
      },
    });
  });

  it("Écrin on the laptop, found on the phone; the phone's colour reaches the laptop", async () => {
    const laptopJar = new Device();
    device = laptopJar;
    await signInHere(izabela);
    let laptop = await enterArea(izabela, studioI.id);
    laptop = await sync(
      changeLocally(laptop, look({ style: "ecrin", mode: "dark" })),
    );
    expect(laptop.confirmed.version).toBe(1);

    device = new Device();
    await signInHere(izabela);
    let phone = await enterArea(izabela, studioI.id);
    expect(displayedAppearance(phone)).toMatchObject({
      style: "ecrin",
      mode: "dark",
    });
    phone = await sync(
      changeLocally(phone, {
        ...displayedAppearance(phone),
        accent: "#2f6f5e",
      }),
    );
    expect(phone.confirmed.appearance.accent).toBe("#2F6F5E");

    device = laptopJar;
    laptop = await readAgain(laptop);
    expect(displayedAppearance(laptop)).toEqual(
      look({ style: "ecrin", mode: "dark", accent: "#2F6F5E" }),
    );
  });

  it("each answer leaves this device a cache of HER preferences (membership, incarnation), rewritten only when it changes", async () => {
    device = new Device();
    await signInHere(izabela);
    cookieWrites.mockClear();
    const read = await getMyPreferencesAction();
    const cached = parseDeviceCache(
      device.get(DEVICE_CACHE_COOKIE)?.value,
      deviceCacheOwner(izabela.userId, studioI.id),
    );
    expect(read.ok && cached).toEqual({
      membershipId: read.ok && read.data.context.membershipId,
      preferences: read.ok && read.data.preferences,
    });
    expect(cookieWrites).toHaveBeenCalledWith(DEVICE_CACHE_COOKIE);
    cookieWrites.mockClear();
    await getMyPreferencesAction();
    expect(cookieWrites).not.toHaveBeenCalledWith(DEVICE_CACHE_COOKIE);
  });

  it("a business sent by the browser that is not the session's: context_changed, nothing written anywhere", async () => {
    device = new Device();
    await signInHere(izabela);
    const before = [
      await rowOf(studioI.id, izabela.userId),
      await rowOf(studioM.id, marie.userId),
    ];
    const { rows } = await db.query(
      "select id from public.business_members where business_id = $1",
      [studioM.id],
    );
    const result = await saveMyPreferencesAction({
      context: { businessId: studioM.id, membershipId: rows[0].id },
      expected: { incarnation: null, version: 0 },
      changes: { style: "studio" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "context_changed" },
    });
    expect([
      await rowOf(studioI.id, izabela.userId),
      await rowOf(studioM.id, marie.userId),
    ]).toEqual(before);
  });

  it.each([
    ["no change", { expected: { incarnation: null, version: 0 }, changes: {} }],
    [
      "no context",
      {
        expected: { incarnation: null, version: 0 },
        changes: { style: "studio" },
      },
    ],
    [
      "a user id",
      {
        userId: "x",
        expected: { incarnation: null, version: 0 },
        changes: { style: "studio" },
      },
    ],
    [
      "an unknown style",
      {
        expected: { incarnation: null, version: 0 },
        changes: { style: "minimal" },
      },
    ],
    [
      "CSS as accent",
      {
        expected: { incarnation: null, version: 0 },
        changes: { accent: "red;x" },
      },
    ],
    ["nothing", undefined],
  ])("refuses %s", async (_label, input) => {
    device = new Device();
    await signInHere(izabela);
    const area = await loadAreaPreferences({
      userId: izabela.userId,
      businessId: studioI.id,
    });
    const withContext =
      input && _label !== "no context"
        ? {
            context: {
              businessId: studioI.id,
              membershipId: area.snapshot!.context.membershipId,
            },
            ...input,
          }
        : input;
    const result = await saveMyPreferencesAction(withContext);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
  });

  it("signed out: refused, nothing sent again; signed in again: a new generation, the same preferences", async () => {
    device = new Device();
    await signInHere(izabela);
    let page = await enterArea(izabela, studioI.id);
    await signOutHere();
    expect(await getMyPreferencesAction()).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    page = changeLocally(page, {
      ...displayedAppearance(page),
      motion: "none",
    });
    const [sending, request] = nextSave(page);
    page = answer(sending, request!, await sendSave(request!));
    expect(page.paused).toBe("context_changed");
    expect(nextSave(page)[1]).toBeNull();
    expect((await rowOf(studioI.id, izabela.userId)).motion).toBe("standard");

    await signInHere(izabela);
    const again = await enterArea(izabela, studioI.id, page);
    expect(again.generation).toBe(page.generation + 1);
    expect(displayedAppearance(again)).toMatchObject({
      style: "ecrin",
      accent: "#2F6F5E",
    });
  });
});

describe("another account on the same device", () => {
  it("A → B: A's page saving after B signed in writes nothing (context_changed), and A's answer never reaches B's state", async () => {
    device = new Device();
    await signInHere(izabela);
    let pageA = await enterArea(izabela, studioI.id);
    pageA = changeLocally(pageA, {
      ...displayedAppearance(pageA),
      accent: "#AAAAAA",
    });
    const [sendingA, requestA] = nextSave(pageA);

    await signOutHere();
    await signInHere(marie);
    let pageB = await enterArea(marie, studioM.id, sendingA);
    pageB = changeLocally(pageB, look({ motion: "none" }));
    const [sendingB, requestB] = nextSave(pageB);

    const before = [
      await rowOf(studioI.id, izabela.userId),
      await rowOf(studioM.id, marie.userId),
    ];
    // A's request reaches the server now, under B's session.
    const resultA = await sendSave(requestA!);
    expect(resultA).toMatchObject({
      ok: false,
      error: { code: "context_changed" },
    });
    expect([
      await rowOf(studioI.id, izabela.userId),
      await rowOf(studioM.id, marie.userId),
    ]).toEqual(before);
    // Its failure, arriving at B's page, changes nothing there.
    expect(answer(sendingB, requestA!, resultA)).toEqual(sendingB);

    const done = await sync(
      answer(sendingB, requestB!, await sendSave(requestB!)),
    );
    expect(await rowOf(studioM.id, marie.userId)).toMatchObject({
      motion: "none",
      version: 1,
    });
    expect((await rowOf(studioI.id, izabela.userId)).accent).toBe("#2F6F5E");
    expect(displayedAppearance(done)).toEqual(look({ motion: "none" }));
  });

  it("A → B → A: an answer of the first A page is ignored by the second", async () => {
    device = new Device();
    await signInHere(izabela);
    let first = await enterArea(izabela, studioI.id);
    first = changeLocally(first, {
      ...displayedAppearance(first),
      motion: "discrete",
    });
    const [sendingFirst, requestFirst] = nextSave(first);
    const lateResult = await sendSave(requestFirst!);
    expect(lateResult.ok).toBe(true);

    await signOutHere();
    await signInHere(marie);
    const b = await enterArea(marie, studioM.id, sendingFirst);
    await signOutHere();
    await signInHere(izabela);
    const second = await enterArea(izabela, studioI.id, b);
    expect(answer(second, requestFirst!, lateResult)).toEqual(second);
  });

  it("the cache left by the previous professional is never shown to the next", async () => {
    device = new Device();
    await signInHere(izabela);
    await getMyPreferencesAction();
    const izabelaCache = device.get(DEVICE_CACHE_COOKIE)?.value;
    await signOutHere();
    await signInHere(marie);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    const offline = await loadAreaPreferences({
      userId: marie.userId,
      businessId: studioM.id,
    });
    expect(device.get(DEVICE_CACHE_COOKIE)?.value).toBe(izabelaCache);
    expect(offline).toMatchObject({ source: "default", snapshot: null });
    expect(offline.appearance).toEqual(defaultAppearancePreferences);
  });
});

describe("leaving the business and joining it again", () => {
  it("three cycles: the old page writes nothing; the new render saves from version 0", async () => {
    const member = await createAccount("act-rejoin");
    const business = await createBusiness(
      (await createAccount("act-owner")).userId,
    );
    device = new Device();
    await signInHere(member);
    let page: SyncState | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      await db.query(
        `insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`,
        [business.id, member.userId],
      );
      if (page) {
        // The page from before she left, still open: refused, nothing written.
        page = changeLocally(
          page,
          look({ style: "carnet", accent: `#0000B${cycle}` }),
        );
        const [sending, request] = nextSave(page);
        page = answer(sending, request!, await sendSave(request!));
        expect(page.paused).toBe("context_changed");
        expect(await rowOf(business.id, member.userId)).toBeNull();
      }
      page = await enterArea(member, business.id, page);
      expect(page.confirmed).toMatchObject({ incarnation: null, version: 0 });
      page = await sync(
        changeLocally(
          page,
          look({ style: "studio", accent: `#0000C${cycle}` }),
        ),
      );
      page = await sync(
        changeLocally(page, { ...displayedAppearance(page), motion: "none" }),
      );
      expect(page.paused).toBeNull();
      expect(await rowOf(business.id, member.userId)).toMatchObject({
        style: "studio",
        accent: `#0000C${cycle}`,
        motion: "none",
        version: 2,
      });
      await db.query(
        "delete from public.business_members where business_id = $1 and user_id = $2",
        [business.id, member.userId],
      );
    }
  });

  it("the database away, then back: her change waits, then is saved (no blocking)", async () => {
    device = new Device();
    await signInHere(izabela);
    let page = await enterArea(izabela, studioI.id);
    await getMyPreferencesAction();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    const area = await loadAreaPreferences({
      userId: izabela.userId,
      businessId: studioI.id,
    });
    expect(area).toMatchObject({ source: "device", snapshot: null });
    expect(area.appearance).toEqual(page.confirmed.appearance);

    const motion =
      page.confirmed.appearance.motion === "none" ? "discrete" : "none";
    page = changeLocally(page, { ...displayedAppearance(page), motion });
    const [sending, request] = nextSave(page);
    const failed = await sendSave(request!);
    expect(failed.ok).toBe(false);
    page = answer(sending, request!, failed);
    // The session cannot be read either: saving pauses, her choice is kept.
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(page.paused).toBe("context_changed");
    expect(displayedAppearance(page).motion).toBe(motion);

    process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
    page = await readAgain(page);
    expect(page.paused).toBeNull();
    page = await sync(page);
    expect((await rowOf(studioI.id, izabela.userId)).motion).toBe(motion);
    expect(displayedAppearance(page).motion).toBe(motion);
  });

  it("a malformed device cache is ignored", async () => {
    device = new Device();
    await signInHere(izabela);
    device.set(DEVICE_CACHE_COOKIE, "2.zzz.<script>");
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
      appearance: { style: "classique" },
      snapshot: { preferences: { version: 0 } },
      deviceAppearanceOffer: {
        style: "studio",
        ambiance: "lin",
        mode: "dark",
        accent: "#97493A",
        motion: "none",
      },
    });
    expect(await rowOf(business.id, fresh.userId)).toBeNull();
    const imported = await importDeviceAppearanceAction({
      context: {
        businessId: business.id,
        membershipId: area.snapshot!.context.membershipId,
      },
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
    const before = await rowOf(studioI.id, izabela.userId);
    const forced = await importDeviceAppearanceAction({
      context: {
        businessId: studioI.id,
        membershipId: area.snapshot!.context.membershipId,
      },
      appearance: look({ ambiance: "sauge" }),
    });
    expect(forced).toMatchObject({ ok: true, data: { status: "stale" } });
    expect(await rowOf(studioI.id, izabela.userId)).toEqual(before);
  });

  it("an import for another context writes nothing", async () => {
    const fresh = await createAccount("act-import-ctx");
    const business = await createBusiness(fresh.userId);
    device = new Device();
    await signInHere(fresh);
    const forged = await importDeviceAppearanceAction({
      context: { businessId: business.id, membershipId: randomUUID() },
      appearance: look({ style: "studio" }),
    });
    expect(forged).toMatchObject({
      ok: false,
      error: { code: "context_changed" },
    });
    const same = await importDeviceAppearanceAction({
      context: { businessId: business.id, membershipId: randomUUID() },
      appearance: look(),
    });
    expect(same).toMatchObject({
      ok: false,
      error: { code: "context_changed" },
    });
    expect(await rowOf(business.id, fresh.userId)).toBeNull();
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
