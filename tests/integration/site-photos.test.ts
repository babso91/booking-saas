import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { GET as getPublicPhoto } from "@/app/api/public/businesses/[slug]/site/photos/[assetId]/[width]/route";
import { GET as getPreviewPhoto } from "@/app/api/sites/photos/[assetId]/[width]/route";
import {
  confirmSitePhotoAction,
  createSitePhotoUploadAction,
  deleteSitePhotoAction,
  listSitePhotosAction,
  revokeSitePhotoAction,
} from "@/features/sites/actions/sites";
import type { SiteConfig } from "@/features/sites/config";
import {
  SITE_PHOTO_BUCKET,
  confirmSitePhoto,
  createSitePhotoUpload,
  revokeSitePhotoForPrivacy,
  sitePhotoFiles,
} from "@/features/sites/data/photos";
import {
  getPublishedSite,
  publishSite,
  restoreSiteVersion,
  saveSiteDraft,
  type SiteWriter,
} from "@/features/sites/data/sites";
import { sampleSiteConfig } from "@/features/sites/site-fixture";
import { AppException } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";

import {
  anonClient,
  bookingClient,
  createBusiness,
  db,
  env,
  type TestBusiness,
} from "./support/fixtures";

// Mini-site photos (supabase/migrations/20261106090000_site_photos.sql,
// docs/SITE_PUBLISHING_CONTRACT.md § 8), against the real local stack:
// Auth, PostgreSQL and Storage. The actions and Route Handlers run as
// Next.js runs them; `next/headers` is one device's cookie jar.

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

// A hook after the conversion (the real one), to land a revocation there.
const afterConversion: { run?: () => Promise<void> } = {};
vi.mock("@/features/sites/photos/process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/sites/photos/process")>();
  return {
    ...actual,
    processSitePhoto: async (input: Buffer) => {
      const result = await actual.processSitePhoto(input);
      const run = afterConversion.run;
      afterConversion.run = undefined;
      await run?.();
      return result;
    },
  };
});

const revalidated = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidated(...args),
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

/** A fresh device, signed in as `account`. */
async function signIn(account: Account) {
  device = new Device();
  const client = await createServerSupabaseClient();
  const { error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) throw error;
}

let alice: Account;
let bruno: Account;
let studioA: TestBusiness;
let studioB: TestBusiness;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  [alice, bruno] = await Promise.all([
    createAccount("photo-alice"),
    createAccount("photo-bruno"),
  ]);
  [studioA, studioB] = await Promise.all([
    createBusiness(alice.userId),
    createBusiness(bruno.userId),
  ]);
});

const writerFor = (business: TestBusiness, account: Account): SiteWriter => ({
  service: bookingClient(),
  businessId: business.id,
  actor: account.userId,
});

async function codeOf(run: () => Promise<unknown>) {
  try {
    await run();
    return "ok";
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
}

/** A phone's photo: turned (orientation 6), with a camera and GPS in EXIF. */
async function phonePhoto(width = 1600, height = 1200) {
  return sharp({
    create: { width, height, channels: 3, background: "#c0563a" },
  })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: "Phone", Model: "Camera 15" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 2400/100" },
    })
    .jpeg()
    .toBuffer();
}

/** What the studio does: ask, send the file as the browser would, confirm. */
async function uploadPhoto(
  file: Buffer,
  declared: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
) {
  const upload = await createSitePhotoUploadAction({
    contentType: declared,
    byteSize: file.byteLength,
  });
  if (!upload.ok) throw new Error(upload.error.code);
  // The browser: no session needed, only the signed token for this path.
  const { error } = await anonClient()
    .storage.from(SITE_PHOTO_BUCKET)
    .uploadToSignedUrl(upload.data.path, upload.data.token, file, {
      contentType: declared,
    });
  if (error) throw error;
  return upload.data;
}

async function storedFiles(businessId: string, assetId: string) {
  const { data, error } = await admin.storage
    .from(SITE_PHOTO_BUCKET)
    .list(`${businessId}/${assetId}`);
  if (error) throw error;
  return data.map((file) => file.name).sort();
}

async function assetRow(id: string) {
  const { rows } = await db.query(
    "select status, content_type, width, height, revoked_reason from public.site_assets where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/** Alice's ready photo (signed in on the current device as her). */
async function readyPhoto() {
  await signIn(alice);
  const upload = await uploadPhoto(await phonePhoto());
  const confirmed = await confirmSitePhotoAction({ assetId: upload.assetId });
  if (!confirmed.ok) throw new Error(confirmed.error.code);
  return upload.assetId;
}

const withCover = (assetId: string | null): SiteConfig => {
  const config = sampleSiteConfig();
  return {
    ...config,
    content: {
      ...config.content,
      cover: assetId ? { asset: assetId } : null,
    },
  };
};

async function currentRevision(businessId: string) {
  const { rows } = await db.query<{ draft_revision: number }>(
    "select draft_revision from public.sites where business_id = $1",
    [businessId],
  );
  return rows[0]?.draft_revision ?? 0;
}

async function publish(business: TestBusiness, config: SiteConfig) {
  const writer = writerFor(business, alice);
  const { revision } = await saveSiteDraft(writer, {
    expectedRevision: await currentRevision(business.id),
    config,
  });
  return publishSite(writer, revision);
}

function publicPhoto(slug: string, assetId: string, width = "828") {
  return getPublicPhoto(
    new NextRequest(
      `http://localhost:3000/api/public/businesses/${slug}/site/photos/${assetId}/${width}`,
    ),
    { params: Promise.resolve({ slug, assetId, width }) },
  );
}

function previewPhoto(assetId: string, width = "480") {
  return getPreviewPhoto(
    new NextRequest(
      `http://localhost:3000/api/sites/photos/${assetId}/${width}`,
    ),
    { params: Promise.resolve({ assetId, width }) },
  );
}

describe("site photos: upload and conversion", () => {
  it("she sends a phone photo: verified, upright, WebP 480/828/1200, original and metadata gone", async () => {
    await signIn(alice);
    const file = await phonePhoto();
    const upload = await uploadPhoto(file);
    expect(upload.path).toBe(`${studioA.id}/${upload.assetId}/original`);
    expect(await assetRow(upload.assetId)).toMatchObject({ status: "pending" });
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual(["original"]);

    const confirmed = await confirmSitePhotoAction({ assetId: upload.assetId });
    expect(confirmed).toMatchObject({
      ok: true,
      data: {
        id: upload.assetId,
        status: "ready",
        contentType: "image/jpeg",
        width: 1200,
        height: 1600,
      },
    });
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([
      "w1200.webp",
      "w480.webp",
      "w828.webp",
    ]);

    const { data } = await admin.storage
      .from(SITE_PHOTO_BUCKET)
      .download(`${studioA.id}/${upload.assetId}/w1200.webp`);
    const bytes = Buffer.from(await data!.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 1200, height: 1600 });
    expect(meta.exif).toBeUndefined();
    expect(bytes.toString("latin1")).not.toContain("Camera 15");

    // Confirmed again: the same answer, nothing redone.
    expect(await confirmSitePhotoAction({ assetId: upload.assetId })).toEqual(
      confirmed,
    );
  });

  it("the REAL type is kept, not the declared one", async () => {
    await signIn(alice);
    const png = await sharp({
      create: { width: 800, height: 600, channels: 4, background: "#123456" },
    })
      .png()
      .toBuffer();
    const upload = await uploadPhoto(png, "image/jpeg");
    const confirmed = await confirmSitePhotoAction({ assetId: upload.assetId });
    expect(confirmed).toMatchObject({
      ok: true,
      data: { contentType: "image/png", width: 800, height: 600 },
    });
  });

  it("a file that is not a photo is refused and forgotten (row and file)", async () => {
    await signIn(alice);
    const upload = await uploadPhoto(
      Buffer.from(
        "<svg xmlns='http://www.w3.org/2000/svg' width='900' height='900'/>",
      ),
    );
    const confirmed = await confirmSitePhotoAction({ assetId: upload.assetId });
    expect(confirmed).toMatchObject({
      ok: false,
      error: { code: "site_photo_unsupported" },
    });
    expect(await assetRow(upload.assetId)).toBeNull();
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([]);
  });

  it("HEIC, other types and oversized files are refused before any upload", async () => {
    await signIn(alice);
    for (const contentType of [
      "image/heic",
      "image/heif",
      "image/svg+xml",
      "image/gif",
    ]) {
      expect(
        await createSitePhotoUploadAction({ contentType, byteSize: 1000 }),
      ).toMatchObject({ ok: false, error: { code: "validation_error" } });
    }
    expect(
      await createSitePhotoUploadAction({
        contentType: "image/jpeg",
        byteSize: 10 * 1024 * 1024 + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "validation_error" } });
    // The database refuses them too, whoever calls it.
    const writer = writerFor(studioA, alice);
    expect(
      await codeOf(() =>
        createSitePhotoUpload(writer, {
          contentType: "image/heic" as "image/jpeg",
          byteSize: 1000,
        }),
      ),
    ).toBe("site_photo_unsupported");
    expect(
      await codeOf(() =>
        createSitePhotoUpload(writer, {
          contentType: "image/jpeg",
          byteSize: 10 * 1024 * 1024 + 1,
        }),
      ),
    ).toBe("site_photo_too_large");
  });

  it("a file up to 10 MB reaches the bucket; above, refused", async () => {
    await signIn(alice);
    const heavy = Buffer.alloc(9 * 1024 * 1024, 7);
    const upload = await uploadPhoto(heavy);
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual(["original"]);
    // Not a photo: refused and forgotten all the same.
    expect(
      await confirmSitePhotoAction({ assetId: upload.assetId }),
    ).toMatchObject({
      ok: false,
      error: { code: "site_photo_unsupported" },
    });
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([]);

    // The bucket itself refuses more, whatever the browser declared.
    const small = await createSitePhotoUploadAction({
      contentType: "image/jpeg",
      byteSize: 1000,
    });
    if (!small.ok) throw new Error(small.error.code);
    const { error } = await anonClient()
      .storage.from(SITE_PHOTO_BUCKET)
      .uploadToSignedUrl(
        small.data.path,
        small.data.token,
        Buffer.alloc(10 * 1024 * 1024 + 1, 7),
        { contentType: "image/jpeg" },
      );
    expect(error).not.toBeNull();
    // And a type it does not take.
    const other = await createSitePhotoUploadAction({
      contentType: "image/jpeg",
      byteSize: 1000,
    });
    if (!other.ok) throw new Error(other.error.code);
    const html = await anonClient()
      .storage.from(SITE_PHOTO_BUCKET)
      .uploadToSignedUrl(
        other.data.path,
        other.data.token,
        Buffer.from("<html>"),
        {
          contentType: "text/html",
        },
      );
    expect(html.error).not.toBeNull();
  });

  it("confirming before the file arrived: not found, the photo stays pending", async () => {
    await signIn(alice);
    const upload = await createSitePhotoUploadAction({
      contentType: "image/jpeg",
      byteSize: 1000,
    });
    if (!upload.ok) throw new Error(upload.error.code);
    expect(
      await confirmSitePhotoAction({ assetId: upload.data.assetId }),
    ).toMatchObject({ ok: false, error: { code: "site_photo_not_found" } });
    expect(await assetRow(upload.data.assetId)).toMatchObject({
      status: "pending",
    });
  });

  it("the signed URL is for its path only, once", async () => {
    await signIn(alice);
    const upload = await createSitePhotoUploadAction({
      contentType: "image/jpeg",
      byteSize: 1000,
    });
    if (!upload.ok) throw new Error(upload.error.code);
    const file = await phonePhoto();
    const bucket = anonClient().storage.from(SITE_PHOTO_BUCKET);
    // Another path (Bruno's business) with her token: refused.
    const elsewhere = await bucket.uploadToSignedUrl(
      `${studioB.id}/${upload.data.assetId}/original`,
      upload.data.token,
      file,
      { contentType: "image/jpeg" },
    );
    expect(elsewhere.error).not.toBeNull();
    const first = await bucket.uploadToSignedUrl(
      upload.data.path,
      upload.data.token,
      file,
      { contentType: "image/jpeg" },
    );
    expect(first.error).toBeNull();
    // No overwrite of a file already sent.
    const again = await bucket.uploadToSignedUrl(
      upload.data.path,
      upload.data.token,
      Buffer.from("replaced"),
      { contentType: "image/jpeg" },
    );
    expect(again.error).not.toBeNull();
  });

  it("at most 20 pending uploads per business and day", async () => {
    const owner = await createAccount("photo-limit");
    const business = await createBusiness(owner.userId);
    const writer = writerFor(business, owner);
    for (let index = 0; index < 20; index++) {
      await createSitePhotoUpload(writer, {
        contentType: "image/jpeg",
        byteSize: 1000,
      });
    }
    expect(
      await codeOf(() =>
        createSitePhotoUpload(writer, {
          contentType: "image/jpeg",
          byteSize: 1000,
        }),
      ),
    ).toBe("rate_limited");
  });
});

describe("site photos: isolation between businesses", () => {
  it("nobody reads or writes the bucket directly: not the public, not a member", async () => {
    const assetId = await readyPhoto();
    const path = `${studioA.id}/${assetId}/w480.webp`;
    // The public.
    const publicRead = await anonClient()
      .storage.from(SITE_PHOTO_BUCKET)
      .download(path);
    expect(publicRead.data).toBeNull();
    // Alice herself, with her session: no storage policy at all.
    const aliceClient = await createServerSupabaseClient();
    const own = await aliceClient.storage
      .from(SITE_PHOTO_BUCKET)
      .download(path);
    expect(own.data).toBeNull();
    const listed = await aliceClient.storage
      .from(SITE_PHOTO_BUCKET)
      .list(studioA.id);
    expect(listed.data ?? []).toEqual([]);
    const written = await aliceClient.storage
      .from(SITE_PHOTO_BUCKET)
      .upload(`${studioA.id}/${randomUUID()}/original`, Buffer.from("x"));
    expect(written.error).not.toBeNull();
    // No public URL works on a private bucket.
    const url = anonClient().storage.from(SITE_PHOTO_BUCKET).getPublicUrl(path)
      .data.publicUrl;
    expect((await fetch(url)).status).toBeGreaterThanOrEqual(400);
  });

  it("Bruno cannot confirm, preview, revoke or delete Alice's photo", async () => {
    const assetId = await readyPhoto();
    await signIn(bruno);
    // Through his session: his business is the only one he acts for.
    expect(await confirmSitePhotoAction({ assetId })).toMatchObject({
      ok: false,
      error: { code: "site_photo_not_found" },
    });
    expect(await revokeSitePhotoAction({ assetId })).toMatchObject({
      ok: false,
      error: { code: "site_photo_not_found" },
    });
    expect(await deleteSitePhotoAction({ assetId })).toMatchObject({
      ok: false,
      error: { code: "site_photo_not_found" },
    });
    const preview = await previewPhoto(assetId);
    expect(preview.status).toBe(404);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    const list = await listSitePhotosAction();
    expect(list.ok && list.data.map((photo) => photo.id)).not.toContain(
      assetId,
    );

    // Naming her business as his: the database refuses the actor.
    const forged = writerFor(studioA, bruno);
    expect(await codeOf(() => confirmSitePhoto(forged, assetId))).toBe(
      "forbidden",
    );
    expect(
      await codeOf(() =>
        createSitePhotoUpload(forged, {
          contentType: "image/jpeg",
          byteSize: 10,
        }),
      ),
    ).toBe("forbidden");
    expect(await assetRow(assetId)).toMatchObject({ status: "ready" });
  });

  it("a site cannot use another business's photo", async () => {
    const assetId = await readyPhoto();
    const writer = writerFor(studioB, bruno);
    expect(
      await codeOf(() =>
        saveSiteDraft(writer, {
          expectedRevision: 0,
          config: withCover(assetId),
        }),
      ),
    ).toBe("site_asset_unavailable");
  });
});

describe("site photos: private preview and public serving", () => {
  it("her preview: her ready photo, published or not, never in a shared cache", async () => {
    const assetId = await readyPhoto();
    const response = await previewPhoto(assetId, "828");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("vercel-cache-tag")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const meta = await sharp(
      Buffer.from(await response.arrayBuffer()),
    ).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 828 });

    // Signed out: refused, never stored.
    device = new Device();
    const signedOut = await previewPhoto(assetId);
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");

    await signIn(alice);
    for (const width of ["100", "1201", "abc"]) {
      const wrong = await previewPhoto(assetId, width);
      expect(wrong.status).toBe(404);
      expect(wrong.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("the public sees a photo only once its version is published", async () => {
    const owner = await createAccount("photo-public");
    alice = owner;
    const business = await createBusiness(owner.userId);
    studioA = business;
    const assetId = await readyPhoto();

    // In the draft only: not served.
    const writer = writerFor(business, owner);
    const { revision } = await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: withCover(assetId),
    });
    let response = await publicPhoto(business.slug, assetId);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");

    await publishSite(writer, revision);
    response = await publicPhoto(business.slug, assetId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=300",
    );
    expect(response.headers.get("cache-control")).not.toContain(
      "stale-while-revalidate",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("vercel-cache-tag")).toBe(
      `site-photo-${assetId}`,
    );
    const meta = await sharp(
      Buffer.from(await response.arrayBuffer()),
    ).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 828 });

    // Under another business's address, a bad width, an unknown photo.
    for (const [slug, id, width] of [
      [studioB.slug, assetId, "828"],
      [business.slug, assetId, "640"],
      [business.slug, randomUUID(), "828"],
      ["unknown-studio-x", assetId, "828"],
      [business.slug, "not-a-uuid", "828"],
    ] as const) {
      const refused = await publicPhoto(slug, id, width);
      expect(refused.status).toBe(404);
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }

    // A newer photo in the draft: still not served while the version
    // online does not have it.
    const draftOnly = await readyPhoto();
    await saveSiteDraft(writer, {
      expectedRevision: await currentRevision(business.id),
      config: withCover(draftOnly),
    });
    expect((await publicPhoto(business.slug, draftOnly)).status).toBe(404);
    expect((await publicPhoto(business.slug, assetId)).status).toBe(200);

    // A version without it goes online: no longer served.
    await publish(business, withCover(null));
    expect((await publicPhoto(business.slug, assetId)).status).toBe(404);
  });
});

describe("site photos: revocation", () => {
  it("revoked: files deleted, never served again, history untouched", async () => {
    const owner = await createAccount("photo-revoke");
    alice = owner;
    const business = await createBusiness(owner.userId);
    studioA = business;
    const assetId = await readyPhoto();
    const v1 = await publish(business, withCover(assetId));
    expect((await publicPhoto(business.slug, assetId)).status).toBe(200);
    const { rows: before } = await db.query(
      "select config from public.site_versions where id = $1",
      [v1.versionId],
    );

    revalidated.mockClear();
    expect(await revokeSitePhotoAction({ assetId })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(revalidated).toHaveBeenCalledWith("/b/[slug]", "page");

    expect(await assetRow(assetId)).toMatchObject({
      status: "revoked",
      revoked_reason: "owner",
    });
    expect(await storedFiles(business.id, assetId)).toEqual([]);
    for (const width of ["480", "828", "1200"]) {
      const response = await publicPhoto(business.slug, assetId, width);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await previewPhoto(assetId)).status).toBe(404);

    // The published version is unchanged; the public read says which of
    // its photos to draw without a photo.
    const { rows: after } = await db.query(
      "select config from public.site_versions where id = $1",
      [v1.versionId],
    );
    expect(after).toEqual(before);
    const site = await getPublishedSite(anonClient(), business.slug);
    expect(site.config.content.cover).toEqual({ asset: assetId });
    expect(site.unavailableAssets).toEqual([assetId]);

    // Final: idempotent, cannot be confirmed or deleted back to life.
    expect(await revokeSitePhotoAction({ assetId })).toMatchObject({
      ok: true,
    });
    expect(await confirmSitePhotoAction({ assetId })).toMatchObject({
      ok: false,
      error: { code: "site_photo_revoked" },
    });
    expect(await deleteSitePhotoAction({ assetId })).toEqual({
      ok: true,
      data: { deleted: false },
    });
    expect(await assetRow(assetId)).toMatchObject({ status: "revoked" });
    const list = await listSitePhotosAction();
    expect(
      list.ok && list.data.find((photo) => photo.id === assetId),
    ).toMatchObject({
      status: "revoked",
    });
  });

  it("an old version restored does not bring a revoked photo back", async () => {
    const owner = await createAccount("photo-restore");
    alice = owner;
    const business = await createBusiness(owner.userId);
    studioA = business;
    const assetId = await readyPhoto();
    const writer = writerFor(business, owner);
    const v1 = await publish(business, withCover(assetId));
    await publish(business, withCover(null));
    await revokeSitePhotoAction({ assetId });

    // Restored into the draft, then published again: allowed (her old
    // layout comes back), the photo does not.
    const { revision } = await restoreSiteVersion(writer, {
      versionId: v1.versionId,
      expectedRevision: await currentRevision(business.id),
    });
    const v3 = await publishSite(writer, revision);
    expect(v3).toMatchObject({ number: 3, created: true });

    const site = await getPublishedSite(anonClient(), business.slug);
    expect(site.versionId).toBe(v3.versionId);
    expect(site.config.content.cover).toEqual({ asset: assetId });
    expect(site.unavailableAssets).toEqual([assetId]);
    for (const width of ["480", "828", "1200"]) {
      expect((await publicPhoto(business.slug, assetId, width)).status).toBe(
        404,
      );
    }
    expect((await previewPhoto(assetId)).status).toBe(404);
    expect(await storedFiles(business.id, assetId)).toEqual([]);

    // Even a file put back under its path by mistake is not served: the
    // database decides, not the bucket.
    await admin.storage
      .from(SITE_PHOTO_BUCKET)
      .upload(`${business.id}/${assetId}/w828.webp`, await phonePhoto(), {
        contentType: "image/webp",
      });
    expect((await publicPhoto(business.slug, assetId)).status).toBe(404);
    expect((await previewPhoto(assetId, "828")).status).toBe(404);
    await admin.storage
      .from(SITE_PHOTO_BUCKET)
      .remove(sitePhotoFiles(business.id, assetId));
  });

  it("a privacy request: revoked by the service, without a member", async () => {
    const owner = await createAccount("photo-privacy");
    alice = owner;
    const business = await createBusiness(owner.userId);
    studioA = business;
    const assetId = await readyPhoto();
    await publish(business, withCover(assetId));

    await revokeSitePhotoForPrivacy(bookingClient(), business.id, assetId);
    expect(await assetRow(assetId)).toMatchObject({
      status: "revoked",
      revoked_reason: "privacy",
    });
    expect(await storedFiles(business.id, assetId)).toEqual([]);
    expect((await publicPhoto(business.slug, assetId)).status).toBe(404);
    // Her own revocation afterwards keeps the first reason.
    await revokeSitePhotoAction({ assetId });
    expect(await assetRow(assetId)).toMatchObject({
      revoked_reason: "privacy",
    });
    // Only the service may call it.
    const { error } = await anonClient().rpc("revoke_site_asset_for_privacy", {
      p_business_id: business.id,
      p_asset_id: assetId,
    });
    expect(error).not.toBeNull();
    // Under the wrong business: not found.
    expect(
      await codeOf(() =>
        revokeSitePhotoForPrivacy(bookingClient(), studioB.id, assetId),
      ),
    ).toBe("site_photo_not_found");
  });

  it("revoked while being converted: its derivatives are deleted, it stays revoked", async () => {
    await signIn(alice);
    const upload = await uploadPhoto(await phonePhoto());
    // Her revocation lands after the conversion, before the confirmation:
    // its files are deleted, then the derivatives are written.
    afterConversion.run = async () => {
      expect(
        await revokeSitePhotoAction({ assetId: upload.assetId }),
      ).toMatchObject({
        ok: true,
      });
    };
    expect(
      await confirmSitePhotoAction({ assetId: upload.assetId }),
    ).toMatchObject({
      ok: false,
      error: { code: "site_photo_revoked" },
    });
    expect(await assetRow(upload.assetId)).toMatchObject({ status: "revoked" });
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([]);
  });
});

describe("site photos: deletion", () => {
  it("deleted only when nothing refers to it, files included", async () => {
    const owner = await createAccount("photo-delete");
    alice = owner;
    const business = await createBusiness(owner.userId);
    studioA = business;
    const assetId = await readyPhoto();
    const writer = writerFor(business, owner);

    // In the draft: in use.
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: withCover(assetId),
    });
    expect(await deleteSitePhotoAction({ assetId })).toMatchObject({
      ok: false,
      error: { code: "site_asset_in_use" },
    });
    // Only in a published version (the draft moved on): still in use.
    await publish(business, withCover(assetId));
    await saveSiteDraft(writer, {
      expectedRevision: await currentRevision(business.id),
      config: withCover(null),
    });
    expect(await deleteSitePhotoAction({ assetId })).toMatchObject({
      ok: false,
      error: { code: "site_asset_in_use" },
    });
    // As a focal point only: in use too.
    const focalOnly = await readyPhoto();
    const config = withCover(null);
    await saveSiteDraft(writer, {
      expectedRevision: await currentRevision(business.id),
      config: {
        ...config,
        content: {
          ...config.content,
          focals: { [focalOnly]: { x: 10, y: 20 } },
        },
      },
    });
    expect(await deleteSitePhotoAction({ assetId: focalOnly })).toMatchObject({
      ok: false,
      error: { code: "site_asset_in_use" },
    });

    // Never used: deleted, row and files.
    const unused = await readyPhoto();
    expect(await deleteSitePhotoAction({ assetId: unused })).toEqual({
      ok: true,
      data: { deleted: true },
    });
    expect(await assetRow(unused)).toBeNull();
    expect(await storedFiles(business.id, unused)).toEqual([]);
    expect(await assetRow(assetId)).toMatchObject({ status: "ready" });
  });
});
