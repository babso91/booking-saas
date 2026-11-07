import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { GET as authCallback } from "@/app/auth/callback/route";
import { GET as getPublicPhoto } from "@/app/api/public/businesses/[slug]/site/photos/[assetId]/[width]/route";
import { GET as getPublicSite } from "@/app/api/public/businesses/[slug]/site/route";
import {
  getOnboardingStatusAction,
  signUpAction,
} from "@/features/auth/actions/auth";
import { createCategoryAction } from "@/features/catalog/actions/catalog";
import { completeOnboardingAction } from "@/features/onboarding/actions/onboarding";
import { createServiceAction } from "@/features/services/actions/services";
import {
  confirmSitePhotoAction,
  createSitePhotoUploadAction,
  getSiteAction,
  publishSiteAction,
  saveSiteDraftAction,
} from "@/features/sites/actions/sites";
import { SITE_PHOTO_BUCKET } from "@/features/sites/data/photos";
import { sampleSiteConfig } from "@/features/sites/site-fixture";

import { createBetaInvitation } from "../../scripts/beta-invite.mjs";
import { anonClient, bookingClient, env, uniqueSlug } from "./support/fixtures";

// The private beta's whole journey on the integrated code, as the product
// runs it (Server Actions, Route Handlers, real Auth, PostgreSQL, Storage and
// Mailpit): invitation → sign-up → confirmation link → onboarding → her
// catalogue → her mini-site → a photo → publication → the public page.

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

const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
});

async function lastAuthLink(email: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await (
      await fetch(
        `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
      )
    ).json();
    const found = list.messages?.[0];
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

function ok<T>(result: { ok: true; data: T } | { ok: false; error: unknown }) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}

describe("the private beta, end to end on the integrated code", () => {
  it("invitation → confirmation → onboarding → catalogue → mini-site → photo → publication → public page", async () => {
    const email = `journey-${randomUUID().slice(0, 8)}@test.local`;
    const { url } = await createBetaInvitation(bookingClient(), {
      email,
      days: 7,
      appUrl: "http://localhost:3000",
    });
    const invitationToken = new URL(url).searchParams.get("invitation")!;

    // Sign-up with her invitation, then the confirmation link of her
    // mailbox, on this device.
    device = new Device();
    expect(
      ok(
        await signUpAction({
          email,
          password: "Mot-de-passe-solide-2026",
          invitationToken,
        }),
      ),
    ).toMatchObject({ status: "confirmation_required" });
    const verified = await fetch(await lastAuthLink(email), {
      redirect: "manual",
    });
    const landing = new URL(verified.headers.get("location")!);
    const callback = await authCallback(new NextRequest(landing));
    expect(new URL(callback.headers.get("location")!).pathname).not.toContain(
      "login",
    );

    // Onboarding.
    expect(ok(await getOnboardingStatusAction())).toMatchObject({
      status: "onboarding_required",
      betaAccess: true,
    });
    const slug = uniqueSlug("journey");
    ok(
      await completeOnboardingAction({
        firstName: "Camille",
        lastName: "Bernard",
        businessName: "Atelier Camille",
        slug,
      }),
    );

    // Her catalogue.
    const category = ok(
      await createCategoryAction({ name: "Cils", requestId: randomUUID() }),
    ) as { id: string };
    ok(
      await createServiceAction({
        name: "Pose complète",
        durationMinutes: 90,
        priceCents: 8500,
        categoryId: category.id,
        requestId: randomUUID(),
      }),
    );

    // Her mini-site: a draft, a photo, the photo as cover, publication.
    ok(await getSiteAction());
    const first = ok(
      await saveSiteDraftAction({
        expectedRevision: 0,
        config: sampleSiteConfig(),
      }),
    );
    const photo = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: "#c0563a" },
    })
      .jpeg()
      .toBuffer();
    const upload = ok(
      await createSitePhotoUploadAction({
        contentType: "image/jpeg",
        byteSize: photo.byteLength,
      }),
    );
    const sent = await anonClient()
      .storage.from(SITE_PHOTO_BUCKET)
      .uploadToSignedUrl(upload.path, upload.token, photo, {
        contentType: "image/jpeg",
      });
    expect(sent.error).toBeNull();
    expect(
      ok(await confirmSitePhotoAction({ assetId: upload.assetId })),
    ).toMatchObject({ status: "ready" });
    const config = sampleSiteConfig();
    const second = ok(
      await saveSiteDraftAction({
        expectedRevision: first.revision,
        config: {
          ...config,
          content: { ...config.content, cover: { asset: upload.assetId } },
        },
      }),
    );
    ok(await publishSiteAction({ expectedRevision: second.revision }));

    // The public page: her published site and its photo.
    const site = await (
      await getPublicSite(
        new NextRequest(
          `http://localhost:3000/api/public/businesses/${slug}/site`,
        ),
        { params: Promise.resolve({ slug }) },
      )
    ).json();
    expect(JSON.stringify(site)).toContain(upload.assetId);
    const served = await getPublicPhoto(
      new NextRequest(
        `http://localhost:3000/api/public/businesses/${slug}/site/photos/${upload.assetId}/828`,
      ),
      {
        params: Promise.resolve({
          slug,
          assetId: upload.assetId,
          width: "828",
        }),
      },
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
  });
});
