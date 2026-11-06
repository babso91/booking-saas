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
import { GET as getCleanup } from "@/app/api/cron/site-photos/route";
import {
  SITE_PHOTO_BUCKET,
  runSitePhotoMaintenance,
  confirmSitePhoto,
  createSitePhotoUpload,
  deleteSitePhoto,
  processSitePhotoPurges,
  reconcileSitePhotoBucket,
  revokeSitePhoto,
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
import { closeTransaction, openTransaction } from "./support/transactions";

/** Resolves once some backend waits for a lock held by `pid`. */
async function waitUntilWaitingFor(pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await db.query(
      "select 1 from pg_stat_activity where $1 = any (pg_blocking_pids(pid))",
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`nothing ever waited for backend ${pid}`);
}

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
    expect(response.headers.get("cache-control")).toBe("no-store");
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

/**
 * The service client, except that deleting files in the photos' bucket
 * fails while `removal.fails` (storage down, network cut): everything else
 * is real.
 */
const removal = { fails: false, attempts: 0 };

/**
 * `beforeUpload` runs once just before the next file is sent to Storage by
 * that client (a conversion stalled after its last check).
 */
const storageHooks: { beforeUpload?: (path: string) => Promise<void> } = {};

function serviceWithFlakyRemoval(): AppSupabaseClient {
  const real = bookingClient();
  const bind = (target: object, value: unknown) =>
    typeof value === "function" ? value.bind(target) : value;
  return new Proxy(real, {
    get(target, property) {
      if (property !== "storage") {
        return bind(target, Reflect.get(target, property));
      }
      const storage = target.storage;
      return new Proxy(storage, {
        get(storageTarget, storageProperty) {
          if (storageProperty !== "from") {
            return bind(
              storageTarget,
              Reflect.get(storageTarget, storageProperty),
            );
          }
          return (bucketName: string) => {
            const bucket = storageTarget.from(bucketName);
            return new Proxy(bucket, {
              get(bucketTarget, bucketProperty) {
                if (bucketProperty === "upload") {
                  return async (
                    ...args: Parameters<typeof bucketTarget.upload>
                  ) => {
                    const hook = storageHooks.beforeUpload;
                    storageHooks.beforeUpload = undefined;
                    await hook?.(args[0]);
                    return bucketTarget.upload(...args);
                  };
                }
                if (bucketProperty === "remove") {
                  return async (paths: string[]) => {
                    removal.attempts += 1;
                    if (removal.fails) {
                      return {
                        data: null,
                        error: new Error("storage unavailable (injected)"),
                      };
                    }
                    return bucketTarget.remove(paths);
                  };
                }
                return bind(
                  bucketTarget,
                  Reflect.get(bucketTarget, bucketProperty),
                );
              },
            });
          };
        },
      });
    },
  }) as AppSupabaseClient;
}

async function purgesOf(assetId: string) {
  const { rows } = await db.query<{ scope: string; attempts: number }>(
    "select scope, attempts from public.site_photo_purges where asset_id = $1 and last_done_at is null order by scope",
    [assetId],
  );
  return rows;
}

describe("site photos: failed and interrupted file deletions", () => {
  async function freshStudio(label: string) {
    const owner = await createAccount(label);
    alice = owner;
    studioA = await createBusiness(owner.userId);
    await signIn(owner);
    return {
      flaky: {
        service: serviceWithFlakyRemoval(),
        businessId: studioA.id,
        actor: owner.userId,
      } satisfies SiteWriter,
      business: studioA,
    };
  }

  it("the original cannot be deleted: no success answered, retried until gone", async () => {
    const { flaky, business } = await freshStudio("purge-original");
    const upload = await uploadPhoto(await phonePhoto());

    removal.fails = true;
    expect(await codeOf(() => confirmSitePhoto(flaky, upload.assetId))).toBe(
      "site_photo_cleanup_pending",
    );
    // Ready (the conversion is done), but its original, with its EXIF and
    // GPS, is still there and its deletion is recorded.
    expect(await assetRow(upload.assetId)).toMatchObject({ status: "ready" });
    expect(await storedFiles(business.id, upload.assetId)).toContain(
      "original",
    );
    expect(await purgesOf(upload.assetId)).toEqual([
      { scope: "original", attempts: 1 },
    ]);
    // Still failing: no success either, the attempt is counted.
    expect(await codeOf(() => confirmSitePhoto(flaky, upload.assetId))).toBe(
      "site_photo_cleanup_pending",
    );
    expect(await purgesOf(upload.assetId)).toEqual([
      { scope: "original", attempts: 2 },
    ]);

    // Confirming again once storage answers: deleted, then ready.
    removal.fails = false;
    expect(await confirmSitePhoto(flaky, upload.assetId)).toMatchObject({
      id: upload.assetId,
      status: "ready",
    });
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "w1200.webp",
      "w480.webp",
      "w828.webp",
    ]);
    expect(await purgesOf(upload.assetId)).toEqual([]);
  });

  it("interrupted after the confirmation: the cleanup deletes the original", async () => {
    const { flaky, business } = await freshStudio("purge-interrupted");
    const upload = await uploadPhoto(await phonePhoto());
    // The process stops right after the confirmation (the removal never
    // succeeds and nobody confirms again).
    removal.fails = true;
    await codeOf(() => confirmSitePhoto(flaky, upload.assetId));
    removal.fails = false;
    expect(await purgesOf(upload.assetId)).toHaveLength(1);

    // Removals still in flight are left alone (requested after `before`).
    const early = await processSitePhotoPurges(bookingClient(), {
      before: new Date(Date.now() - 60 * 60 * 1000),
      limit: 100,
    });
    expect(early).toEqual({ done: 0, failed: 0 });
    expect(await storedFiles(business.id, upload.assetId)).toContain(
      "original",
    );

    const later = await processSitePhotoPurges(bookingClient(), {
      before: new Date(Date.now() + 1000),
      limit: 500,
    });
    expect(later.failed).toBe(0);
    expect(later.done).toBeGreaterThanOrEqual(1);
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "w1200.webp",
      "w480.webp",
      "w828.webp",
    ]);
    expect(await purgesOf(upload.assetId)).toEqual([]);
    expect(await assetRow(upload.assetId)).toMatchObject({ status: "ready" });
  });

  it("revocation whose files cannot be deleted: not served, recorded, retried", async () => {
    const { flaky, business } = await freshStudio("purge-revoke");
    const assetId = await readyPhoto();
    await publish(business, withCover(assetId));
    expect((await publicPhoto(business.slug, assetId)).status).toBe(200);

    removal.fails = true;
    expect(await codeOf(() => revokeSitePhoto(flaky, assetId))).toBe(
      "site_photo_cleanup_pending",
    );
    // Revoked all the same: never served again, even with its files there.
    expect(await assetRow(assetId)).toMatchObject({ status: "revoked" });
    expect((await publicPhoto(business.slug, assetId)).status).toBe(404);
    expect((await previewPhoto(assetId)).status).toBe(404);
    expect(await storedFiles(business.id, assetId)).toHaveLength(3);
    expect(await purgesOf(assetId)).toEqual([{ scope: "all", attempts: 1 }]);

    removal.fails = false;
    await revokeSitePhoto(flaky, assetId);
    expect(await storedFiles(business.id, assetId)).toEqual([]);
    expect(await purgesOf(assetId)).toEqual([]);
    expect(await assetRow(assetId)).toMatchObject({ status: "revoked" });
  });

  it("deletion whose files cannot be deleted: retrying the deletion finishes it", async () => {
    const { flaky, business } = await freshStudio("purge-delete");
    const assetId = await readyPhoto();

    removal.fails = true;
    expect(await codeOf(() => deleteSitePhoto(flaky, assetId))).toBe(
      "site_photo_cleanup_pending",
    );
    expect(await assetRow(assetId)).toBeNull();
    expect(await storedFiles(business.id, assetId)).toHaveLength(3);
    expect(await purgesOf(assetId)).toEqual([{ scope: "all", attempts: 1 }]);
    // Not served meanwhile: the photo no longer exists.
    expect((await previewPhoto(assetId)).status).toBe(404);
    // Another business cannot use the retry to learn about it, nor touch
    // its purge.
    const other = writerFor(studioB, bruno);
    expect(await codeOf(() => deleteSitePhoto(other, assetId))).toBe(
      "site_photo_not_found",
    );
    expect(await purgesOf(assetId)).toEqual([{ scope: "all", attempts: 1 }]);

    removal.fails = false;
    expect(await deleteSitePhoto(flaky, assetId)).toEqual({ deleted: true });
    expect(await storedFiles(business.id, assetId)).toEqual([]);
    expect(await purgesOf(assetId)).toEqual([]);
    // Then gone for good: not found, as any unknown photo.
    expect(await codeOf(() => deleteSitePhoto(flaky, assetId))).toBe(
      "site_photo_not_found",
    );
  });

  it("an original left, then the photo revoked: one deletion clears both", async () => {
    const { flaky, business } = await freshStudio("purge-both");
    const upload = await uploadPhoto(await phonePhoto());
    removal.fails = true;
    await codeOf(() => confirmSitePhoto(flaky, upload.assetId));
    removal.fails = false;
    expect(await purgesOf(upload.assetId)).toEqual([
      { scope: "original", attempts: 1 },
    ]);
    await revokeSitePhoto(flaky, upload.assetId);
    expect(await storedFiles(business.id, upload.assetId)).toEqual([]);
    expect(await purgesOf(upload.assetId)).toEqual([]);
  });

  it("a refused file whose removal fails: forgotten, its files left to the cleanup", async () => {
    const { flaky, business } = await freshStudio("purge-discard");
    const upload = await uploadPhoto(Buffer.from("not a photo at all"));
    removal.fails = true;
    expect(await codeOf(() => confirmSitePhoto(flaky, upload.assetId))).toBe(
      "site_photo_unsupported",
    );
    removal.fails = false;
    expect(await assetRow(upload.assetId)).toBeNull();
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "original",
    ]);
    expect(await purgesOf(upload.assetId)).toEqual([
      { scope: "all", attempts: 1 },
    ]);
    await processSitePhotoPurges(bookingClient(), {
      before: new Date(Date.now() + 1000),
      limit: 500,
    });
    expect(await storedFiles(business.id, upload.assetId)).toEqual([]);
    expect(await purgesOf(upload.assetId)).toEqual([]);
  });

  it("a business deleted: its photos' files are recorded for deletion", async () => {
    const { business } = await freshStudio("purge-business");
    const ready = await readyPhoto();
    const revoked = await readyPhoto();
    await revokeSitePhotoAction({ assetId: revoked });
    await db.query("delete from public.businesses where id = $1", [
      business.id,
    ]);
    expect(await purgesOf(ready)).toEqual([{ scope: "all", attempts: 0 }]);
    expect(await storedFiles(business.id, ready)).toHaveLength(3);
    await processSitePhotoPurges(bookingClient(), {
      before: new Date(Date.now() + 1000),
      limit: 500,
    });
    expect(await storedFiles(business.id, ready)).toEqual([]);
    expect(await purgesOf(ready)).toEqual([]);
  });

  it("a purge is completed only under its own business", async () => {
    const { flaky, business } = await freshStudio("purge-scope");
    const assetId = await readyPhoto();
    removal.fails = true;
    await codeOf(() => revokeSitePhoto(flaky, assetId));
    removal.fails = false;
    const service = bookingClient();
    for (const name of [
      "complete_site_photo_purge",
      "fail_site_photo_purge",
    ] as const) {
      const { error } = await service.rpc(name, {
        p_business_id: studioB.id,
        p_asset_id: assetId,
        p_scope: "all",
      });
      expect(error).toBeNull();
    }
    expect(await purgesOf(assetId)).toEqual([{ scope: "all", attempts: 1 }]);
    await processSitePhotoPurges(service, {
      before: new Date(Date.now() + 1000),
      limit: 500,
    });
    expect(await storedFiles(business.id, assetId)).toEqual([]);
    expect(await purgesOf(assetId)).toEqual([]);
  });

  it("nobody but the service sees or touches the purges", async () => {
    const { error: read } = await anonClient()
      .from("site_photo_purges" as never)
      .select("*");
    expect(read).not.toBeNull();
    for (const [name, args] of [
      [
        "pending_site_photo_purges",
        { p_before: new Date().toISOString(), p_limit: 10 },
      ],
      [
        "complete_site_photo_purge",
        { p_asset_id: randomUUID(), p_scope: "all" },
      ],
      ["fail_site_photo_purge", { p_asset_id: randomUUID(), p_scope: "all" }],
    ] as const) {
      const { error } = await anonClient().rpc(name as never, args as never);
      expect(error).not.toBeNull();
    }
    await signIn(alice);
    const member = await createServerSupabaseClient();
    const { data } = await member
      .from("site_photo_purges" as never)
      .select("*");
    expect(data ?? []).toEqual([]);
  });
});

// --- Codex audit -------------------------------------------------------------

/** The signed upload URL's 2 hours have passed (as far as the cleanup knows). */
async function uploadWindowPassed(assetId: string) {
  const { rows } = await db.query(
    "select 1 from information_schema.columns where table_schema = 'public' and table_name = 'site_photo_purges' and column_name = 'not_before'",
  );
  if (rows.length === 0) return;
  await db.query(
    "update public.site_photo_purges set not_before = now() - interval '1 second' where asset_id = $1",
    [assetId],
  );
}

/**
 * The safety period of the bucket's reconciliation has passed for the
 * suspect files of `businessId` (and only those).
 */
async function orphansAged(businessId: string) {
  const { rows } = await db.query(
    "select to_regclass('public.site_photo_orphans') is not null as exists",
  );
  if (!rows[0].exists) return;
  await db.query(
    "update public.site_photo_orphans set first_seen_at = now() - interval '2 hours' where name like $1",
    [`${businessId}/%`],
  );
}

/** The periodic cleanup, run now. */
async function cleanUpNow() {
  return processSitePhotoPurges(bookingClient(), {
    before: new Date(Date.now() + 1000),
    limit: 500,
  });
}

async function replay(upload: { path: string; token: string }) {
  return anonClient()
    .storage.from(SITE_PHOTO_BUCKET)
    .uploadToSignedUrl(upload.path, upload.token, Buffer.from("replayed"), {
      contentType: "image/jpeg",
    });
}

describe("site photos: the signed upload URL replayed (Codex audit)", () => {
  it("after confirmation: the replayed original is deleted once the URL has expired", async () => {
    await signIn(alice);
    const upload = await uploadPhoto(await phonePhoto());
    expect(
      await confirmSitePhotoAction({ assetId: upload.assetId }),
    ).toMatchObject({
      ok: true,
    });
    expect(await storedFiles(studioA.id, upload.assetId)).not.toContain(
      "original",
    );

    // Storage accepts the same URL again while it is valid (2 hours): the
    // path is free since the original was deleted.
    expect((await replay(upload)).error).toBeNull();
    expect(await storedFiles(studioA.id, upload.assetId)).toContain("original");

    // Once the URL can no longer write, the cleanup deletes it for good.
    await uploadWindowPassed(upload.assetId);
    await cleanUpNow();
    expect(await storedFiles(studioA.id, upload.assetId)).not.toContain(
      "original",
    );
    // Never served, at any moment: only the derivatives are.
    expect((await previewPhoto(upload.assetId, "480")).status).toBe(200);
  });

  it("after revocation: nothing written by the old URL survives its expiry", async () => {
    await signIn(alice);
    const upload = await uploadPhoto(await phonePhoto());
    await confirmSitePhotoAction({ assetId: upload.assetId });
    await revokeSitePhotoAction({ assetId: upload.assetId });
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([]);

    expect((await replay(upload)).error).toBeNull();
    await uploadWindowPassed(upload.assetId);
    await cleanUpNow();
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([]);
  });

  it("after deletion: the same", async () => {
    await signIn(alice);
    const upload = await uploadPhoto(await phonePhoto());
    await confirmSitePhotoAction({ assetId: upload.assetId });
    expect(
      await deleteSitePhotoAction({ assetId: upload.assetId }),
    ).toMatchObject({
      ok: true,
    });
    expect((await replay(upload)).error).toBeNull();
    await uploadWindowPassed(upload.assetId);
    await cleanUpNow();
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([]);
  });
});

describe("site photos: a save racing a deletion (Codex audit)", () => {
  it("a photo deleted while the save waited for the site: the save is refused", async () => {
    const owner = await createAccount("photo-race");
    alice = owner;
    const business = await createBusiness(owner.userId);
    studioA = business;
    const assetId = await readyPhoto();
    const writer = writerFor(business, owner);
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: withCover(null),
    });

    // Her deletion of that photo (nothing refers to it yet) is in progress:
    // it holds the site and has deleted the photo, not committed yet.
    const deletion = await openTransaction({ role: "service_role" });
    await deletion.connection.query(
      "select public.delete_site_asset($1, $2, $3)",
      [business.id, owner.userId, assetId],
    );
    // Meanwhile a save puts that photo on her cover.
    const save = codeOf(() =>
      saveSiteDraft(writer, {
        expectedRevision: 1,
        config: withCover(assetId),
      }),
    );
    await waitUntilWaitingFor(deletion.pid);
    await closeTransaction(deletion, "commit");

    expect(await save).toBe("site_asset_unavailable");
    const { rows } = await db.query(
      "select draft_config -> 'content' -> 'cover' as cover from public.sites where business_id = $1",
      [business.id],
    );
    expect(rows[0].cover).toBeNull();
  });
});

describe("site photos: the periodic cleanup", () => {
  it("an upload abandoned past its URL's expiry: forgotten, its files deleted", async () => {
    await signIn(alice);
    const upload = await uploadPhoto(await phonePhoto());
    // Never confirmed; its upload URL is long expired.
    await db.query(
      "update public.site_assets set created_at = now() - interval '3 hours' where id = $1",
      [upload.assetId],
    );
    // A pending upload still within its window: left alone.
    const fresh = await uploadPhoto(await phonePhoto());

    const result = await runSitePhotoMaintenance(bookingClient());
    expect(result.abandoned).toBeGreaterThanOrEqual(1);
    expect(await assetRow(upload.assetId)).toBeNull();
    expect(await storedFiles(studioA.id, upload.assetId)).toEqual([]);
    expect(await assetRow(fresh.assetId)).toMatchObject({ status: "pending" });
    expect(await storedFiles(studioA.id, fresh.assetId)).toEqual(["original"]);
  });

  it("GET /api/cron/site-photos: the cleanup with the cron secret, nothing without", async () => {
    process.env.CRON_SECRET = "site-photos-cron-secret-0123456789abcdef";
    const refused = await getCleanup(
      new Request("http://localhost:3000/api/cron/site-photos"),
    );
    expect(refused.status).toBe(401);
    const wrong = await getCleanup(
      new Request("http://localhost:3000/api/cron/site-photos", {
        headers: { authorization: "Bearer not-the-secret" },
      }),
    );
    expect(wrong.status).toBe(401);
    const run = await getCleanup(
      new Request("http://localhost:3000/api/cron/site-photos", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    expect(run.status).toBe(200);
    expect((await run.json()).data).toMatchObject({
      abandoned: expect.any(Number),
      done: expect.any(Number),
      failed: 0,
    });
  });

  it("a purge done early stays recorded until the upload URL has expired", async () => {
    await signIn(alice);
    const upload = await uploadPhoto(await phonePhoto());
    await confirmSitePhotoAction({ assetId: upload.assetId });
    const { rows } = await db.query(
      "select scope, last_done_at is not null as done, not_before > now() + interval '1 hour' as later from public.site_photo_purges where asset_id = $1",
      [upload.assetId],
    );
    expect(rows).toEqual([{ scope: "original", done: true, later: true }]);
    // Not due yet: the cleanup leaves it.
    await cleanUpNow();
    expect(
      (
        await db.query(
          "select 1 from public.site_photo_purges where asset_id = $1",
          [upload.assetId],
        )
      ).rows,
    ).toHaveLength(1);
    await uploadWindowPassed(upload.assetId);
    await cleanUpNow();
    expect(
      (
        await db.query(
          "select 1 from public.site_photo_purges where asset_id = $1",
          [upload.assetId],
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe("site photos: a conversion outliving its photo (Codex counter-audit)", () => {
  async function lateStudio(label: string) {
    const owner = await createAccount(label);
    alice = owner;
    studioA = await createBusiness(owner.userId);
    await signIn(owner);
    return {
      owner,
      business: studioA,
      flaky: {
        service: serviceWithFlakyRemoval(),
        businessId: studioA.id,
        actor: owner.userId,
      } satisfies SiteWriter,
    };
  }

  /** An upload sent long ago: its URL has expired. */
  async function sentLongAgo(assetId: string) {
    await db.query(
      "update public.site_assets set created_at = now() - interval '3 hours' where id = $1",
      [assetId],
    );
  }

  const hasConversions = async () =>
    (
      await db.query(
        "select to_regclass('public.site_photo_conversions') is not null as exists",
      )
    ).rows[0].exists as boolean;

  /** The conversion's deadline has passed: nothing may write for it. */
  async function conversionDeadlinePassed(assetId: string) {
    if (!(await hasConversions())) return;
    await db.query(
      "update public.site_photo_conversions set deadline = now() - interval '1 second' where asset_id = $1",
      [assetId],
    );
  }

  async function conversionsOf(assetId: string) {
    if (!(await hasConversions())) return 0;
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.site_photo_conversions where asset_id = $1",
      [assetId],
    );
    return rows[0]!.n;
  }

  /** The periodic cleanup, everything due included. */
  const cleanUp = (service: AppSupabaseClient = bookingClient()) =>
    runSitePhotoMaintenance(service, { now: new Date(Date.now() + 120_000) });

  it.each(["deleted", "revoked"] as const)(
    "%s during a slow conversion, its purge closed, the catch-up failing: the late files are deleted after the deadline",
    async (outcome) => {
      const { owner, business, flaky } = await lateStudio(`late-${outcome}`);
      const upload = await uploadPhoto(await phonePhoto());
      await sentLongAgo(upload.assetId);
      // Converted; before its files are written, she removes the photo from
      // another tab: its files are deleted, its purge done and closed (the
      // upload URL expired long ago). Then Storage fails for a while.
      afterConversion.run = async () => {
        const writer = writerFor(business, owner);
        if (outcome === "deleted") {
          expect(await deleteSitePhoto(writer, upload.assetId)).toEqual({
            deleted: true,
          });
        } else {
          await revokeSitePhoto(writer, upload.assetId);
        }
        expect(await purgesOf(upload.assetId)).toEqual([]);
        removal.fails = true;
      };
      try {
        expect(
          await codeOf(() => confirmSitePhoto(flaky, upload.assetId)),
        ).toBe(
          outcome === "deleted" ? "site_photo_not_found" : "site_photo_revoked",
        );
      } finally {
        removal.fails = false;
      }
      // The late WebP files are there, for a photo gone or revoked.
      expect(await storedFiles(business.id, upload.assetId)).toEqual([
        "w1200.webp",
        "w480.webp",
        "w828.webp",
      ]);

      // Cleanups before the deadline: the obligation stays.
      await cleanUp();
      await cleanUp();
      // After it, Storage still down: the files stay, recorded, retried.
      await conversionDeadlinePassed(upload.assetId);
      removal.fails = true;
      try {
        await cleanUp(serviceWithFlakyRemoval());
      } finally {
        removal.fails = false;
      }
      expect(await conversionsOf(upload.assetId)).toBe(0);
      expect(await purgesOf(upload.assetId)).toMatchObject([{ scope: "all" }]);
      // Storage back: gone, and the cleanups repeated change nothing more.
      await cleanUp();
      expect(await storedFiles(business.id, upload.assetId)).toEqual([]);
      await cleanUp();
      await cleanUp();
      expect(await storedFiles(business.id, upload.assetId)).toEqual([]);
      expect(await purgesOf(upload.assetId)).toEqual([]);
    },
  );

  it("the cleanup during her conversion leaves her photo: her confirmation finishes", async () => {
    const { business } = await lateStudio("late-abandoned");
    const upload = await uploadPhoto(await phonePhoto());
    await sentLongAgo(upload.assetId);
    afterConversion.run = async () => {
      await cleanUp();
    };
    expect(
      await confirmSitePhotoAction({ assetId: upload.assetId }),
    ).toMatchObject({ ok: true, data: { status: "ready" } });
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "w1200.webp",
      "w480.webp",
      "w828.webp",
    ]);
    // Its obligation, settled after the deadline: a ready photo keeps its
    // files.
    await conversionDeadlinePassed(upload.assetId);
    await cleanUp();
    expect(await conversionsOf(upload.assetId)).toBe(0);
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "w1200.webp",
      "w480.webp",
      "w828.webp",
    ]);
  });

  it("the process dies after writing a file: the photo and every file go once the deadline has passed", async () => {
    const { owner, business } = await lateStudio("late-killed");
    const upload = await uploadPhoto(await phonePhoto());
    await sentLongAgo(upload.assetId);
    // What the conversion did before the process was killed.
    const { error } = await bookingClient().rpc("begin_site_photo_conversion", {
      p_business_id: business.id,
      p_actor: owner.userId,
      p_asset_id: upload.assetId,
    });
    expect(error).toBeNull();
    await admin.storage
      .from(SITE_PHOTO_BUCKET)
      .upload(
        `${business.id}/${upload.assetId}/w480.webp`,
        Buffer.from("webp"),
        { contentType: "image/webp" },
      );
    // Before the deadline: it may still finish, nothing is removed.
    await cleanUp();
    expect(await assetRow(upload.assetId)).toMatchObject({ status: "pending" });
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "original",
      "w480.webp",
    ]);
    // After: forgotten, every file deleted, nothing left to do.
    await conversionDeadlinePassed(upload.assetId);
    await cleanUp();
    expect(await assetRow(upload.assetId)).toBeNull();
    expect(await storedFiles(business.id, upload.assetId)).toEqual([]);
    expect(await conversionsOf(upload.assetId)).toBe(0);
    expect(await purgesOf(upload.assetId)).toEqual([]);
  });

  it("too close to its deadline, the conversion writes nothing; confirming again works", async () => {
    const { business } = await lateStudio("late-deadline");
    const upload = await uploadPhoto(await phonePhoto());
    afterConversion.run = async () => {
      await db.query(
        "update public.site_photo_conversions set deadline = now() + interval '1 minute' where asset_id = $1",
        [upload.assetId],
      );
    };
    expect(
      await confirmSitePhotoAction({ assetId: upload.assetId }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "original",
    ]);
    expect(await assetRow(upload.assetId)).toMatchObject({ status: "pending" });
    expect(
      await confirmSitePhotoAction({ assetId: upload.assetId }),
    ).toMatchObject({ ok: true, data: { status: "ready" } });
  });

  it("stalled after its last check, written after its obligation was settled: the late file is found and deleted", async () => {
    const { owner, business, flaky } = await lateStudio("late-stalled");
    const upload = await uploadPhoto(await phonePhoto());
    await sentLongAgo(upload.assetId);
    // The conversion passed its last check; before its file reaches
    // Storage it stalls past its deadline. Meanwhile she deletes the photo
    // and the cleanup settles everything: no obligation is left.
    storageHooks.beforeUpload = async () => {
      expect(
        await deleteSitePhoto(writerFor(business, owner), upload.assetId),
      ).toEqual({ deleted: true });
      await conversionDeadlinePassed(upload.assetId);
      await cleanUp();
      expect(await conversionsOf(upload.assetId)).toBe(0);
      expect(await purgesOf(upload.assetId)).toEqual([]);
      removal.fails = true;
    };
    try {
      // The late file lands; the next check refuses; the catch-up fails.
      expect(await codeOf(() => confirmSitePhoto(flaky, upload.assetId))).toBe(
        "conflict",
      );
    } finally {
      removal.fails = false;
      storageHooks.beforeUpload = undefined;
    }
    expect(await storedFiles(business.id, upload.assetId)).toEqual([
      "w480.webp",
    ]);
    // Nothing recorded can find it: no photo, no purge, no conversion.
    expect(await assetRow(upload.assetId)).toBeNull();
    expect(await purgesOf(upload.assetId)).toEqual([]);
    expect(await conversionsOf(upload.assetId)).toBe(0);

    // The cleanups go on (Storage back): it is found, then deleted.
    await cleanUp();
    await cleanUp();
    await orphansAged(business.id);
    await cleanUp();
    expect(await storedFiles(business.id, upload.assetId)).toEqual([]);
  });

  it("nobody but the service sees or records a conversion", async () => {
    const { owner, business } = await lateStudio("late-rights");
    const upload = await uploadPhoto(await phonePhoto());
    const member = await bookingClient().rpc("begin_site_photo_conversion", {
      p_business_id: business.id,
      p_actor: bruno.userId,
      p_asset_id: upload.assetId,
    });
    expect(member.error?.message).toBe("forbidden");
    for (const client of [anonClient()]) {
      const { error } = await client.rpc("begin_site_photo_conversion", {
        p_business_id: business.id,
        p_actor: owner.userId,
        p_asset_id: upload.assetId,
      });
      expect(error).not.toBeNull();
      const read = await client
        .from("site_photo_conversions" as never)
        .select();
      expect(read.error ?? read.data).toBeTruthy();
      expect(read.data ?? []).toEqual([]);
    }
  });
});

describe("site photos: the bucket reconciled with the database", () => {
  async function studio(label: string) {
    const owner = await createAccount(label);
    alice = owner;
    studioA = await createBusiness(owner.userId);
    await signIn(owner);
    return { owner, business: studioA };
  }

  /** An object written straight into the bucket (late, by anyone). */
  async function put(name: string) {
    const { error } = await admin.storage
      .from(SITE_PHOTO_BUCKET)
      .upload(name, Buffer.from("x"), {
        contentType: "image/webp",
        upsert: true,
      });
    if (error) throw error;
  }

  /** Which of `names` Storage holds (its own index). */
  async function present(names: string[]) {
    const { rows } = await db.query<{ name: string }>(
      "select name from storage.objects where bucket_id = 'site-photos' and name = any($1) and archived_at is null and not is_delete_marker",
      [names],
    );
    return rows.map((row) => row.name).sort();
  }

  async function suspectsOf(businessId: string) {
    const { rows } = await db.query<{ name: string; attempts: number }>(
      "select name, attempts from public.site_photo_orphans where name like $1 order by name",
      [`${businessId}/%`],
    );
    return rows;
  }

  /**
   * Runs until a pass over the whole bucket has ended (the pass in
   * progress first, if any), as the periodic cleanup would over several
   * runs. Answers the summed counts.
   */
  async function fullPass(
    service: AppSupabaseClient = bookingClient(),
    options: { pageSize?: number; maxPages?: number } = {},
  ) {
    const totals = { runs: 0, scanned: 0, deleted: 0, failed: 0, skipped: 0 };
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const result = await reconcileSitePhotoBucket(service, options);
      totals.runs += 1;
      if (result.skipped) {
        totals.skipped += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      if ("error" in result) throw new Error("reconciliation failed");
      totals.scanned += result.scanned;
      totals.deleted += result.deleted;
      totals.failed += result.failed;
      if (result.complete) return totals;
    }
    throw new Error("the pass never ended");
  }

  /** A photo row of `businessId`, ready, without going through the studio. */
  async function readyRow(businessId: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.site_assets (business_id, status, content_type, byte_size, width, height)
       values ($1, 'ready', 'image/webp', 1000, 480, 640) returning id`,
      [businessId],
    );
    return rows[0]!.id;
  }

  it("only what no photo justifies is deleted, after the safety period; nothing legitimate is ever touched", async () => {
    const { owner, business } = await studio("reconcile-safety");
    const b = business.id;
    // Legitimate.
    const ready = await readyPhoto();
    const pending = await uploadPhoto(await phonePhoto());
    const converting = await uploadPhoto(await phonePhoto());
    await bookingClient().rpc("begin_site_photo_conversion", {
      p_business_id: b,
      p_actor: owner.userId,
      p_asset_id: converting.assetId,
    });
    await put(`${b}/${converting.assetId}/w480.webp`);
    const othersPhoto = await readyRow(studioB.id);
    await put(`${studioB.id}/${othersPhoto}/w480.webp`);
    const legitimate = [
      `${b}/${ready}/w1200.webp`,
      `${b}/${ready}/w480.webp`,
      `${b}/${ready}/w828.webp`,
      `${b}/${pending.assetId}/original`,
      `${b}/${converting.assetId}/original`,
      `${b}/${converting.assetId}/w480.webp`,
      `${studioB.id}/${othersPhoto}/w480.webp`,
    ].sort();
    // Suspects: no photo; a ready photo's original; a revoked photo's
    // file; another business's photo under her folder.
    const revoked = await readyPhoto();
    await revokeSitePhoto(writerFor(business, owner), revoked);
    const suspects = [
      `${b}/${randomUUID()}/w828.webp`,
      `${b}/${ready}/original`,
      `${b}/${revoked}/w480.webp`,
      `${b}/${othersPhoto}/w480.webp`,
    ].sort();
    // Outside the photos' layout: never deleted.
    const outside = [
      `${b}/${ready}/notes.webp`,
      `${b}/${randomUUID()}/notes.webp`,
      `${b}/${randomUUID()}/nested/w480.webp`,
      `${b}/readme.webp`,
    ].sort();
    for (const name of [...suspects, ...outside]) await put(name);
    const everything = [...legitimate, ...suspects, ...outside].sort();
    expect(await present(everything)).toEqual(everything);

    // First pass: suspects recorded, nothing deleted (safety period).
    // The ready and the revoked photos were converted moments ago: while
    // their conversion may still write, their files are left alone.
    await fullPass();
    expect((await suspectsOf(b)).map((row) => row.name)).toEqual(
      suspects.filter(
        (name) =>
          !name.includes(`/${ready}/`) && !name.includes(`/${revoked}/`),
      ),
    );
    expect(await present(everything)).toEqual(everything);
    await db.query(
      "update public.site_photo_conversions set deadline = now() - interval '1 second' where asset_id = any($1)",
      [[ready, revoked]],
    );
    await fullPass();
    expect((await suspectsOf(b)).map((row) => row.name)).toEqual(suspects);
    expect(await present(everything)).toEqual(everything);

    // Once suspected for the safety period: deleted, and only them.
    await orphansAged(b);
    const second = await fullPass();
    expect(second.deleted).toBeGreaterThanOrEqual(suspects.length);
    expect(await present(everything)).toEqual(
      [...legitimate, ...outside].sort(),
    );
    expect(await suspectsOf(b)).toEqual([]);
    // Also as Storage lists them.
    expect(await storedFiles(b, ready)).toEqual([
      "notes.webp",
      "w1200.webp",
      "w480.webp",
      "w828.webp",
    ]);

    // Repeated: nothing more goes.
    await fullPass();
    await orphansAged(b);
    await fullPass();
    expect(await present(everything)).toEqual(
      [...legitimate, ...outside].sort(),
    );
  });

  it("a file written after a pass is found by the next one", async () => {
    const { business } = await studio("reconcile-late");
    await fullPass();
    const late = `${business.id}/${randomUUID()}/w480.webp`;
    await put(late);
    expect(await suspectsOf(business.id)).toEqual([]);
    await fullPass();
    expect(await suspectsOf(business.id)).toMatchObject([{ name: late }]);
    await orphansAged(business.id);
    await fullPass();
    expect(await present([late])).toEqual([]);
  });

  it("by small pages over several runs: every object examined, the pass resumed where it stopped", async () => {
    const { business } = await studio("reconcile-pages");
    const legit = await readyRow(business.id);
    await put(`${business.id}/${legit}/w480.webp`);
    const orphans = Array.from(
      { length: 5 },
      () => `${business.id}/${randomUUID()}/w828.webp`,
    ).sort();
    for (const name of orphans) await put(name);
    await fullPass(); // the pass in progress, if any, ends
    // One page of two per run: no run sees the whole bucket.
    const first = await reconcileSitePhotoBucket(bookingClient(), {
      pageSize: 2,
      maxPages: 1,
    });
    expect(first).toMatchObject({
      skipped: false,
      scanned: 2,
      complete: false,
    });
    const paged = await fullPass(bookingClient(), { pageSize: 2, maxPages: 1 });
    expect(paged.runs).toBeGreaterThan(2);
    expect((await suspectsOf(business.id)).map((row) => row.name)).toEqual(
      orphans,
    );
    await orphansAged(business.id);
    await fullPass(bookingClient(), { pageSize: 2, maxPages: 1 });
    expect(await present(orphans)).toEqual([]);
    expect(await present([`${business.id}/${legit}/w480.webp`])).toHaveLength(
      1,
    );
  });

  it("Storage failing the deletion: recorded, counted, deleted once it answers again", async () => {
    const { business } = await studio("reconcile-storage");
    const orphan = `${business.id}/${randomUUID()}/w480.webp`;
    await put(orphan);
    await fullPass();
    await orphansAged(business.id);
    removal.fails = true;
    let failing;
    try {
      failing = await fullPass(serviceWithFlakyRemoval());
    } finally {
      removal.fails = false;
    }
    expect(failing.failed).toBeGreaterThanOrEqual(1);
    expect(await present([orphan])).toEqual([orphan]);
    expect(await suspectsOf(business.id)).toMatchObject([
      { name: orphan, attempts: 1 },
    ]);
    const { data: status } = await bookingClient().rpc(
      "site_photo_reconciliation_status",
    );
    expect(status).toMatchObject({ failingSuspects: expect.any(Number) });
    expect(
      (status as { failingSuspects: number }).failingSuspects,
    ).toBeGreaterThanOrEqual(1);

    await fullPass();
    expect(await present([orphan])).toEqual([]);
    expect(await suspectsOf(business.id)).toEqual([]);
  });

  it("the inventory failing: nothing deleted, the error reported, then resumed", async () => {
    const { business } = await studio("reconcile-listing");
    const orphan = `${business.id}/${randomUUID()}/w480.webp`;
    await put(orphan);
    await fullPass();
    await orphansAged(business.id);
    const { data: before } = await bookingClient().rpc(
      "site_photo_reconciliation_status",
    );
    // Every page of the inventory fails (database or network).
    const real = bookingClient();
    const failingInventory = new Proxy(real, {
      get(target, property) {
        if (property === "rpc") {
          return (name: string, ...args: unknown[]) =>
            name === "site_photo_reconciliation_page"
              ? Promise.resolve({
                  data: null,
                  error: {
                    code: "57014",
                    message: "canceling statement (injected)",
                    details: "",
                    hint: "",
                  },
                })
              : (target.rpc as (...all: unknown[]) => unknown)(name, ...args);
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AppSupabaseClient;
    const result = await runSitePhotoMaintenance(failingInventory);
    expect(result.reconciliation).toEqual({ skipped: false, error: true });
    expect(await present([orphan])).toEqual([orphan]);
    const { data: after } = await bookingClient().rpc(
      "site_photo_reconciliation_status",
    );
    // No pass is said complete on a failed inventory.
    expect((after as { lastPassCompletedAt: string }).lastPassCompletedAt).toBe(
      (before as { lastPassCompletedAt: string }).lastPassCompletedAt,
    );
    // The lease was released: the next run goes on, and deletes it.
    await fullPass();
    expect(await present([orphan])).toEqual([]);
  });

  it("two runs at once: one holds the pass; together they never delete anything legitimate", async () => {
    const { business } = await studio("reconcile-concurrent");
    const legit = await readyRow(business.id);
    const legitName = `${business.id}/${legit}/w480.webp`;
    await put(legitName);
    const orphans = Array.from(
      { length: 3 },
      () => `${business.id}/${randomUUID()}/w480.webp`,
    );
    for (const name of orphans) await put(name);
    await fullPass();

    // A run holds the pass: another one is skipped.
    const holder = randomUUID();
    const { data: cursor } = await bookingClient().rpc(
      "claim_site_photo_reconciliation",
      { p_run: holder },
    );
    expect(cursor).not.toBeNull();
    expect(await reconcileSitePhotoBucket(bookingClient())).toEqual({
      skipped: true,
    });
    await bookingClient().rpc("release_site_photo_reconciliation", {
      p_run: holder,
    });

    await orphansAged(business.id);
    await Promise.all([
      fullPass(bookingClient(), { pageSize: 3, maxPages: 2 }),
      fullPass(bookingClient(), { pageSize: 3, maxPages: 2 }),
    ]);
    expect(await present([legitName, ...orphans])).toEqual([legitName]);
  });

  it("the converter crashing before or after writing, its obligation lost: the files still end", async () => {
    const { owner, business } = await studio("reconcile-crash");
    // Before writing: nothing but her original, which stays hers.
    const before = await uploadPhoto(await phonePhoto());
    await bookingClient().rpc("begin_site_photo_conversion", {
      p_business_id: business.id,
      p_actor: owner.userId,
      p_asset_id: before.assetId,
    });
    // After writing: a derivative of a photo then gone, and every record
    // of it lost (no photo, no conversion, no purge).
    const after = await uploadPhoto(await phonePhoto());
    await bookingClient().rpc("begin_site_photo_conversion", {
      p_business_id: business.id,
      p_actor: owner.userId,
      p_asset_id: after.assetId,
    });
    await put(`${business.id}/${after.assetId}/w480.webp`);
    await db.query("delete from public.site_assets where id = $1", [
      after.assetId,
    ]);
    await db.query("delete from public.site_photo_purges where asset_id = $1", [
      after.assetId,
    ]);
    await db.query(
      "delete from public.site_photo_conversions where asset_id = any($1)",
      [[before.assetId, after.assetId]],
    );

    await fullPass();
    await orphansAged(business.id);
    await fullPass();
    expect(await storedFiles(business.id, after.assetId)).toEqual([]);
    expect(await storedFiles(business.id, before.assetId)).toEqual([
      "original",
    ]);
    expect(await assetRow(before.assetId)).toMatchObject({ status: "pending" });
  });

  it("observable: the last complete pass and its counts", async () => {
    await fullPass();
    const { data, error } = await bookingClient().rpc(
      "site_photo_reconciliation_status",
    );
    expect(error).toBeNull();
    const status = data as {
      lastPassCompletedAt: string;
      passInProgress: boolean;
      lastPass: { scanned: number };
    };
    expect(Date.now() - Date.parse(status.lastPassCompletedAt)).toBeLessThan(
      60_000,
    );
    expect(status.passInProgress).toBe(false);
    expect(status.lastPass.scanned).toBeGreaterThan(0);
    // Nobody but the service reads it.
    const { error: anonymous } = await anonClient().rpc(
      "site_photo_reconciliation_status",
    );
    expect(anonymous).not.toBeNull();
  });
});
