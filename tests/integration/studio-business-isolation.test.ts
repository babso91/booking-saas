import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  studioConfirmPhotoAction,
  studioCreatePhotoUploadAction,
  studioGetVersionAction,
  studioListVersionsAction,
  studioPublishAction,
  studioReadSiteAction,
  studioRestoreVersionAction,
  studioSaveDraftAction,
} from "@/features/experience/studio/server-actions";
import type { SiteConfig } from "@/features/sites/config";
import { sampleSiteConfig } from "@/features/sites/site-fixture";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";

import { createBusiness, db, env, type TestBusiness } from "./support/fixtures";

// Codex's audit of #45: the studio of business A stays open, the session
// moves to business B (another account signed in, in another tab), then a
// late save of studio A leaves. The session decides the business on every
// call, so with matching revisions A's draft would land in B. Every studio
// call now carries the business it was opened for, and the server refuses
// it when the session's is another one: nothing read, nothing written.

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

// One browser: its cookies are whatever session was signed in last.
const device = new Device();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => device.getAll(),
    get: (name: string) => device.get(name),
    set: (name: string, value: string, options?: { maxAge?: number }) =>
      device.set(name, value, options),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

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

/** The same browser, now signed in as `account`. */
async function signIn(account: Account) {
  device.cookies.clear();
  const client = await createServerSupabaseClient();
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) throw error;
}

const named = (name: string): SiteConfig => {
  const base = sampleSiteConfig();
  return { ...base, brand: { ...base.brand, name } };
};

async function draftOf(business: TestBusiness) {
  const { rows } = await db.query<{
    draft_revision: number;
    name: string;
    published: string | null;
  }>(
    `select draft_revision, draft_config->'brand'->>'name' as name,
            published_version_id as published
       from public.sites where business_id = $1`,
    [business.id],
  );
  return rows[0];
}

let alice: Account;
let bruno: Account;
let studioA: TestBusiness;
let studioB: TestBusiness;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  [alice, bruno] = await Promise.all([
    createAccount("iso-alice"),
    createAccount("iso-bruno"),
  ]);
  [studioA, studioB] = await Promise.all([
    createBusiness(alice.userId),
    createBusiness(bruno.userId),
  ]);
});

describe("a studio is bound to the business it was opened for", () => {
  it("A → B, a late save of A with the same revision: refused, B untouched", async () => {
    // Each business has its draft at revision 1.
    await signIn(bruno);
    expect(
      await studioSaveDraftAction({
        businessId: studioB.id,
        expectedRevision: 0,
        config: named("Bruno B"),
      }),
    ).toEqual({ ok: true, data: { revision: 1 } });
    await signIn(alice);
    expect(
      await studioSaveDraftAction({
        businessId: studioA.id,
        expectedRevision: 0,
        config: named("Alice A"),
      }),
    ).toEqual({ ok: true, data: { revision: 1 } });

    // Studio A stays open; the browser's session moves to Bruno (B).
    await signIn(bruno);

    // Studio A's late save, on revision 1 — which B's draft also has.
    expect(
      await studioSaveDraftAction({
        businessId: studioA.id,
        expectedRevision: 1,
        config: named("Alice A, plus tard"),
      }),
    ).toMatchObject({ ok: false, error: { code: "site_business_changed" } });

    expect(await draftOf(studioB)).toEqual({
      draft_revision: 1,
      name: "Bruno B",
      published: null,
    });
    expect(await draftOf(studioA)).toMatchObject({
      draft_revision: 1,
      name: "Alice A",
    });
  });

  it("every other call of studio A is refused too, under B's session", async () => {
    await signIn(bruno);
    const refused = { ok: false, error: { code: "site_business_changed" } };
    const of = studioA.id;
    const version = randomUUID();

    expect(
      await studioPublishAction({ businessId: of, expectedRevision: 1 }),
    ).toMatchObject(refused);
    expect(await studioReadSiteAction({ businessId: of })).toMatchObject(
      refused,
    );
    expect(await studioListVersionsAction({ businessId: of })).toMatchObject(
      refused,
    );
    expect(
      await studioGetVersionAction({ businessId: of, versionId: version }),
    ).toMatchObject(refused);
    expect(
      await studioRestoreVersionAction({
        businessId: of,
        versionId: version,
        expectedRevision: 1,
      }),
    ).toMatchObject(refused);
    expect(
      await studioCreatePhotoUploadAction({
        businessId: of,
        contentType: "image/jpeg",
        byteSize: 1000,
      }),
    ).toMatchObject(refused);
    expect(
      await studioConfirmPhotoAction({ businessId: of, assetId: version }),
    ).toMatchObject(refused);

    // Nothing was published, nothing was created for B.
    expect((await draftOf(studioB))!.published).toBeNull();
    const { rows } = await db.query(
      "select 1 from public.site_assets where business_id = $1",
      [studioB.id],
    );
    expect(rows).toEqual([]);
  });

  it("a studio without its business is refused before anything is read", async () => {
    await signIn(bruno);
    expect(
      await studioSaveDraftAction({
        expectedRevision: 1,
        config: named("Sans activité"),
      }),
    ).toMatchObject({ ok: false, error: { code: "validation_error" } });
    expect((await draftOf(studioB))!.name).toBe("Bruno B");
  });

  it("her own studio, under her own session, works as before", async () => {
    await signIn(bruno);
    expect(
      await studioSaveDraftAction({
        businessId: studioB.id,
        expectedRevision: 1,
        config: named("Bruno B, suite"),
      }),
    ).toEqual({ ok: true, data: { revision: 2 } });
    expect(
      await studioPublishAction({
        businessId: studioB.id,
        expectedRevision: 2,
      }),
    ).toMatchObject({ ok: true, data: { number: 1 } });
  });
});
