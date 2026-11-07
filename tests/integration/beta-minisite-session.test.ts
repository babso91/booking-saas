import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { signInAction } from "@/features/auth/actions/auth";
import { completeOnboardingAction } from "@/features/onboarding/actions/onboarding";
import {
  createSitePhotoUploadAction,
  getSiteAction,
  saveSiteDraftAction,
} from "@/features/sites/actions/sites";
import { sampleSiteConfig } from "@/features/sites/site-fixture";
import type { Database } from "@/types/database.generated";

import { createBetaInvitation } from "../../scripts/beta-invite.mjs";
import { bookingClient, db, env, uniqueSlug } from "./support/fixtures";

// The combination of #47 (access bound to the proving session) and the
// mini-sites (#40, #43): their actions resolve the business with
// getBusinessContext (Auth's getUser, then business_members under RLS)
// before any service-role write. An earlier session, revoked or kept by
// Auth, must be stopped there.

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

// Ending the other sessions, replaced when Auth answers "done" but keeps
// them.
const hooks: { keepOthers?: boolean } = {};
vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  return {
    ...actual,
    createServerSupabaseClient: async (
      ...args: Parameters<typeof actual.createServerSupabaseClient>
    ) => {
      const client = await actual.createServerSupabaseClient(...args);
      const signOut = client.auth.signOut.bind(client.auth);
      client.auth.signOut = (async (
        ...signOutArgs: Parameters<typeof signOut>
      ) => {
        if (signOutArgs[0]?.scope === "others" && hooks.keepOthers) {
          return { error: null };
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

const codeOf = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? "ok" : result.error!.code;

describe("an earlier session and her mini-site (#47 with #40/#43)", () => {
  it.each([
    ["revoked", false, "unauthenticated"],
    ["kept by Auth despite its answer", true, "no_business"],
  ] as const)(
    "the earlier session (%s) neither reads nor writes her site; hers does",
    async (_label, keepOthers, refusal) => {
      const email = `minisite-${randomUUID().slice(0, 8)}@test.local`;
      await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      const { url } = await createBetaInvitation(bookingClient(), {
        email,
        days: 7,
        appUrl: "http://localhost:3000",
      });
      const token = new URL(url).searchParams.get("invitation")!;

      // An earlier session, on another device.
      const earlier = new Device();
      device = earlier;
      expect(codeOf(await signInAction({ email, password: PASSWORD }))).toBe(
        "ok",
      );

      // Her proof: password and invitation, then her business.
      const hers = new Device();
      device = hers;
      hooks.keepOthers = keepOthers;
      try {
        expect(
          await signInAction({
            email,
            password: PASSWORD,
            invitationToken: token,
          }),
        ).toMatchObject({ ok: true, data: { invitation: "accepted" } });
      } finally {
        hooks.keepOthers = false;
      }
      expect(
        codeOf(
          await completeOnboardingAction({
            firstName: "Camille",
            lastName: "Bernard",
            businessName: "Atelier Camille",
            slug: uniqueSlug("atelier"),
          }),
        ),
      ).toBe("ok");
      expect(codeOf(await getSiteAction())).toBe("ok");

      // The earlier session: stopped before any service-role write.
      device = earlier;
      expect(codeOf(await getSiteAction())).toBe(refusal);
      expect(
        codeOf(
          await saveSiteDraftAction({
            expectedRevision: 0,
            config: sampleSiteConfig(),
          }),
        ),
      ).toBe(refusal);
      expect(
        codeOf(
          await createSitePhotoUploadAction({
            contentType: "image/jpeg",
            byteSize: 1000,
          }),
        ),
      ).toBe(refusal);
      const { rows } = await db.query<{ n: number }>(
        `select (select count(*) from public.sites s join public.business_members m on m.business_id = s.business_id join auth.users u on u.id = m.user_id where u.email = $1)::int
              + (select count(*) from public.site_assets a join public.business_members m on m.business_id = a.business_id join auth.users u on u.id = m.user_id where u.email = $1)::int as n`,
        [email],
      );
      expect(rows[0]!.n).toBe(0);

      // Hers: writes.
      device = hers;
      expect(
        codeOf(
          await saveSiteDraftAction({
            expectedRevision: 0,
            config: sampleSiteConfig(),
          }),
        ),
      ).toBe("ok");
    },
  );
});
