import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { SiteConfig } from "@/features/sites/config";
import {
  getPublishedSite,
  getSite,
  getSiteVersion,
  listSiteVersions,
  publishSite,
  restoreSiteVersion,
  saveSiteDraft,
  type SiteWriter,
} from "@/features/sites/data/sites";
import { saveSiteDraftSchema } from "@/features/sites/schemas";
import { sampleSiteConfig } from "@/features/sites/site-fixture";
import { AppException } from "@/lib/errors";

import {
  anonClient,
  bookingClient,
  createBusiness,
  createProfessional,
  db,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
} from "./support/transactions";

// Mini-sites (supabase/migrations/20261105090000_site_publishing.sql,
// docs/SITE_PUBLISHING_CONTRACT.md): private draft with revisions, atomic
// publication, immutable history, restoration, public read of the
// published version only, plan as a render-time lens. Real sessions, real
// RLS; writes with the service client for a member, as the actions do.

let alice: Professional;
let bruno: Professional;

beforeAll(async () => {
  [alice, bruno] = await Promise.all([
    createProfessional("site-alice"),
    createProfessional("site-bruno"),
  ]);
});

async function studioOf(pro: Professional) {
  return createBusiness(pro.userId);
}

const writerFor = (business: TestBusiness, pro: Professional): SiteWriter => ({
  service: bookingClient(),
  businessId: business.id,
  actor: pro.userId,
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

async function readyAsset(businessId: string, status = "ready") {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.site_assets (business_id, status, content_type, byte_size, width, height)
     values ($1, $2, 'image/jpeg', 1000, 1200, 1600) returning id`,
    [businessId, status],
  );
  return rows[0]!.id;
}

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

const named = (name: string, base: SiteConfig = sampleSiteConfig()) => ({
  ...base,
  brand: { ...base.brand, name },
});

describe("the draft", () => {
  it("is created by her first save, then moves by revision; a stale write is refused", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    expect(await getSite(alice.client, studio.id)).toBeNull();

    expect(
      await saveSiteDraft(writer, { expectedRevision: 0, config: named("Un") }),
    ).toEqual({ revision: 1 });
    expect(
      await saveSiteDraft(writer, {
        expectedRevision: 1,
        config: named("Deux"),
      }),
    ).toEqual({ revision: 2 });
    // Another studio still at revision 1: refused, nothing written.
    expect(
      await codeOf(() =>
        saveSiteDraft(writer, { expectedRevision: 1, config: named("Trois") }),
      ),
    ).toBe("stale_site_draft");
    // The same write retried after its answer was lost: answered as it is.
    expect(
      await saveSiteDraft(writer, {
        expectedRevision: 1,
        config: named("Deux"),
      }),
    ).toEqual({ revision: 2 });

    const site = await getSite(alice.client, studio.id);
    expect(site).toMatchObject({
      plan: "core",
      revision: 2,
      schemaVersion: 1,
      config: named("Deux"),
      published: null,
    });
  });

  it("two studios saving at once: exactly one wins", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    await saveSiteDraft(writer, { expectedRevision: 0, config: named("Base") });
    const results = await Promise.all(
      ["A", "B", "C", "D"].map((name) =>
        codeOf(() =>
          saveSiteDraft(writer, { expectedRevision: 1, config: named(name) }),
        ),
      ),
    );
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(
      results.filter((result) => result === "stale_site_draft"),
    ).toHaveLength(3);
    expect((await getSite(alice.client, studio.id))!.revision).toBe(2);
  });

  it("two first saves at once: one creates the site, the other is stale", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    const results = await Promise.all(
      ["A", "B"].map((name) =>
        codeOf(() =>
          saveSiteDraft(writer, { expectedRevision: 0, config: named(name) }),
        ),
      ),
    );
    expect(results.sort()).toEqual(["ok", "stale_site_draft"]);
    const { rows } = await db.query(
      "select count(*)::int as n from public.sites where business_id = $1",
      [studio.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("publication and history", () => {
  it("publishes atomically; the public sees the published version only; history never changes", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: named("Premier"),
    });
    expect(
      await codeOf(() => getPublishedSite(anonClient(), studio.slug)),
    ).toBe("site_not_published");

    const v1 = await publishSite(writer, 1);
    expect(v1).toMatchObject({ number: 1, created: true });
    expect(await getPublishedSite(anonClient(), studio.slug)).toMatchObject({
      versionId: v1.versionId,
      number: 1,
      plan: "core",
      config: named("Premier"),
    });

    // Her draft moves on: the public still sees version 1.
    await saveSiteDraft(writer, {
      expectedRevision: 1,
      config: named("Brouillon"),
    });
    expect(
      (await getPublishedSite(anonClient(), studio.slug)).config.brand.name,
    ).toBe("Premier");
    // Publishing a stale revision: refused.
    expect(await codeOf(() => publishSite(writer, 1))).toBe("stale_site_draft");

    const v2 = await publishSite(writer, 2);
    expect(v2).toMatchObject({ number: 2, created: true });
    // Publishing again without a change: the same version, no duplicate.
    expect(await publishSite(writer, 2)).toEqual({ ...v2, created: false });

    const versions = await listSiteVersions(alice.client, studio.id);
    expect(
      versions.map((version) => [version.number, version.current]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    const before = await getSiteVersion(alice.client, studio.id, v1.versionId);

    // Immutable, even for the database owner.
    for (const sql of [
      "update public.site_versions set config = '{}'::jsonb where id = $1",
      "update public.site_versions set number = 9 where id = $1",
      "delete from public.site_versions where id = $1",
    ]) {
      expect(await outcome(db.query(sql, [v1.versionId]))).toBe(
        "site_version_immutable",
      );
    }
    expect(await getSiteVersion(alice.client, studio.id, v1.versionId)).toEqual(
      before,
    );
  });

  it("an uncommitted publication is invisible, and one rolled back leaves no trace", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: named("En ligne"),
    });
    await publishSite(writer, 1);
    await saveSiteDraft(writer, {
      expectedRevision: 1,
      config: named("Suivante"),
    });

    const publishing = await openTransaction();
    await publishing.connection.query(
      "select * from public.publish_site($1, $2, 2)",
      [studio.id, alice.userId],
    );
    expect(
      (await getPublishedSite(anonClient(), studio.slug)).config.brand.name,
    ).toBe("En ligne");
    await closeTransaction(publishing, "rollback");
    expect(
      (await getPublishedSite(anonClient(), studio.slug)).config.brand.name,
    ).toBe("En ligne");
    expect(
      (await listSiteVersions(alice.client, studio.id)).map((v) => v.number),
    ).toEqual([1]);

    // Committed this time: the next number, and the public switches.
    const committing = await openTransaction();
    await committing.connection.query(
      "select * from public.publish_site($1, $2, 2)",
      [studio.id, alice.userId],
    );
    await closeTransaction(committing, "commit");
    expect(await getPublishedSite(anonClient(), studio.slug)).toMatchObject({
      number: 2,
      config: { brand: { name: "Suivante" } },
    });
  });

  it("publications at once: one version, every answer the same", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: named("Une fois"),
    });
    const answers = await Promise.all(
      [1, 2, 3, 4, 5].map(() => publishSite(writer, 1)),
    );
    expect(new Set(answers.map((answer) => answer.versionId)).size).toBe(1);
    expect(answers.filter((answer) => answer.created)).toHaveLength(1);
    expect(await listSiteVersions(alice.client, studio.id)).toHaveLength(1);
  });

  it("a publication arriving while another is in progress waits for it, then answers its version", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: named("Simultanée"),
    });

    const first = await openTransaction();
    const { rows } = await first.connection.query<{ version_id: string }>(
      "select * from public.publish_site($1, $2, 1)",
      [studio.id, alice.userId],
    );
    const second = publishSite(writer, 1);
    await waitUntilWaitingFor(first.pid);
    await closeTransaction(first, "commit");
    expect(await second).toMatchObject({
      versionId: rows[0]!.version_id,
      number: 1,
      created: false,
    });
    expect(await listSiteVersions(alice.client, studio.id)).toHaveLength(1);
  });

  it("restoring copies an old version into the draft; publishing it adds a version", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: named("Printemps"),
    });
    const v1 = await publishSite(writer, 1);
    await saveSiteDraft(writer, { expectedRevision: 1, config: named("Été") });
    const v2 = await publishSite(writer, 2);
    const v1Before = await getSiteVersion(
      alice.client,
      studio.id,
      v1.versionId,
    );

    expect(
      await restoreSiteVersion(writer, {
        versionId: v1.versionId,
        expectedRevision: 2,
      }),
    ).toEqual({
      revision: 3,
    });
    // Retried: answered as it is.
    expect(
      await restoreSiteVersion(writer, {
        versionId: v1.versionId,
        expectedRevision: 2,
      }),
    ).toEqual({
      revision: 3,
    });
    expect(await getSite(alice.client, studio.id)).toMatchObject({
      revision: 3,
      config: named("Printemps"),
      restoredFrom: v1.versionId,
      published: { versionId: v2.versionId },
    });
    // Not public until published.
    expect(
      (await getPublishedSite(anonClient(), studio.slug)).config.brand.name,
    ).toBe("Été");

    const v3 = await publishSite(writer, 3);
    expect(v3.number).toBe(3);
    expect(
      await getSiteVersion(alice.client, studio.id, v3.versionId),
    ).toMatchObject({
      restoredFrom: v1.versionId,
      config: named("Printemps"),
      current: true,
    });
    expect(await getSiteVersion(alice.client, studio.id, v1.versionId)).toEqual(
      {
        ...v1Before,
        current: false,
      },
    );
    // A version of another site: not found.
    const other = await studioOf(bruno);
    const otherWriter = writerFor(other, bruno);
    await saveSiteDraft(otherWriter, {
      expectedRevision: 0,
      config: named("Bruno"),
    });
    expect(
      await codeOf(() =>
        restoreSiteVersion(otherWriter, {
          versionId: v1.versionId,
          expectedRevision: 1,
        }),
      ),
    ).toBe("site_version_not_found");
  });
});

describe("isolation between businesses", () => {
  it("nobody else reads or writes her site; the public reads her published version only", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    await saveSiteDraft(writer, {
      expectedRevision: 0,
      config: named("Privé"),
    });
    const v1 = await publishSite(writer, 1);
    await saveSiteDraft(writer, {
      expectedRevision: 1,
      config: named("Brouillon secret"),
    });

    // Another professional, signed in.
    for (const table of ["sites", "site_versions", "site_assets"] as const) {
      const { data } = await bruno.client
        .from(table)
        .select("*")
        .eq("business_id", studio.id);
      expect(data).toEqual([]);
    }
    expect(await getSite(bruno.client, studio.id)).toBeNull();
    // The public: no table at all, only the published version.
    for (const table of ["sites", "site_versions", "site_assets"] as const) {
      const { error } = await anonClient().from(table).select("*").limit(1);
      expect(error).not.toBeNull();
    }
    const published = await getPublishedSite(anonClient(), studio.slug);
    expect(published.versionId).toBe(v1.versionId);
    expect(JSON.stringify(published)).not.toContain("Brouillon secret");

    // Writes in her business by someone who is not a member: forbidden.
    const intruder = { ...writer, actor: bruno.userId };
    expect(
      await codeOf(() =>
        saveSiteDraft(intruder, {
          expectedRevision: 2,
          config: named("Intrus"),
        }),
      ),
    ).toBe("forbidden");
    expect(await codeOf(() => publishSite({ ...intruder }, 2))).toBe(
      "forbidden",
    );
    expect(
      await codeOf(() =>
        restoreSiteVersion(intruder, {
          versionId: v1.versionId,
          expectedRevision: 2,
        }),
      ),
    ).toBe("forbidden");

    // The write functions are the service's: not callable with a session.
    for (const client of [alice.client, bruno.client, anonClient()]) {
      const save = await client.rpc("save_site_draft", {
        p_business_id: studio.id,
        p_actor: alice.userId,
        p_expected_revision: 2,
        p_schema_version: 1,
        p_config: named("Direct"),
      });
      expect(save.error).not.toBeNull();
      const plan = await client.rpc("set_site_plan", {
        p_business_id: studio.id,
        p_plan: "signature",
      });
      expect(plan.error).not.toBeNull();
    }
    expect((await getSite(alice.client, studio.id))!).toMatchObject({
      revision: 2,
      plan: "core",
      config: named("Brouillon secret"),
    });
  });

  it("only her own ready photos can be referenced", async () => {
    const studio = await studioOf(alice);
    const other = await studioOf(bruno);
    const writer = writerFor(studio, alice);
    const mine = await readyAsset(studio.id);
    const pending = await readyAsset(studio.id, "pending");
    const theirs = await readyAsset(other.id);
    const withCover = (asset: string) => {
      const base = sampleSiteConfig();
      return {
        ...base,
        content: {
          ...base.content,
          cover: { asset },
          focals: { [asset]: { x: 40, y: 30 } },
        },
      };
    };
    for (const asset of [theirs, pending, randomUUID()]) {
      expect(
        await codeOf(() =>
          saveSiteDraft(writer, {
            expectedRevision: 0,
            config: withCover(asset),
          }),
        ),
      ).toBe("site_asset_unavailable");
    }
    // A focal point of a photo that is not hers is refused too.
    const base = sampleSiteConfig();
    expect(
      await codeOf(() =>
        saveSiteDraft(writer, {
          expectedRevision: 0,
          config: {
            ...base,
            content: { ...base.content, focals: { [theirs]: { x: 1, y: 1 } } },
          },
        }),
      ),
    ).toBe("site_asset_unavailable");
    expect(
      await saveSiteDraft(writer, {
        expectedRevision: 0,
        config: withCover(mine),
      }),
    ).toEqual({ revision: 1 });
  });
});

describe("plans: a lens, never a rewrite", () => {
  it("changing plan keeps her draft and her versions; the public read carries the current plan", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    // A Signature composition saved while on Core: kept, dormant.
    const signature: SiteConfig = {
      ...sampleSiteConfig(),
      sections: [
        { kind: "opening", variant: "kinetic" },
        { kind: "services", variant: "tiles" },
        { kind: "work", variant: "filmstrip" },
      ],
      tokens: {
        ...sampleSiteConfig().tokens,
        type: "condensed",
        motion: "snap",
      },
    };
    await saveSiteDraft(writer, { expectedRevision: 0, config: signature });
    const v1 = await publishSite(writer, 1);
    const before = await getSiteVersion(alice.client, studio.id, v1.versionId);

    const service = bookingClient();
    for (const plan of ["signature", "core", "signature"] as const) {
      const { error } = await service.rpc("set_site_plan", {
        p_business_id: studio.id,
        p_plan: plan,
      });
      expect(error).toBeNull();
      expect(await getPublishedSite(anonClient(), studio.slug)).toMatchObject({
        plan,
        config: signature,
      });
    }
    expect(await getSiteVersion(alice.client, studio.id, v1.versionId)).toEqual(
      before,
    );
    expect((await getSite(alice.client, studio.id))!.config).toEqual(signature);

    const { error } = await service.rpc("set_site_plan", {
      p_business_id: studio.id,
      p_plan: "gold",
    });
    expect(error?.message).toBe("invalid_input");
  });
});

describe("validation", () => {
  it("the actions refuse a malformed configuration before anything is written", () => {
    const base = sampleSiteConfig();
    expect(
      saveSiteDraftSchema.safeParse({ expectedRevision: 0, config: base })
        .success,
    ).toBe(true);
    expect(
      saveSiteDraftSchema.safeParse({
        expectedRevision: 0,
        config: {
          ...base,
          brand: { ...base.brand, intro: "<script>x</script>" },
        },
      }).success,
    ).toBe(false);
  });

  it("the database refuses what is not a version-1 document", async () => {
    const studio = await studioOf(alice);
    const service = bookingClient();
    for (const [schema, config] of [
      [2, sampleSiteConfig()],
      [1, ["not", "an", "object"]],
      [1, { blob: "x".repeat(270_000) }],
    ] as const) {
      const { error } = await service.rpc("save_site_draft", {
        p_business_id: studio.id,
        p_actor: alice.userId,
        p_expected_revision: 0,
        p_schema_version: schema,
        p_config: config as never,
      });
      expect(error?.message).toBe("invalid_site_config");
    }
  });

  it("an unreadable draft can be saved, never published", async () => {
    const studio = await studioOf(alice);
    const writer = writerFor(studio, alice);
    const base = sampleSiteConfig();
    const unreadable = {
      ...base,
      tokens: {
        ...base.tokens,
        palette: { ...base.tokens.palette, ink: "#1c1c1c" },
      },
    };
    expect(
      await saveSiteDraft(writer, { expectedRevision: 0, config: unreadable }),
    ).toEqual({ revision: 1 });
    expect(await codeOf(() => publishSite(writer, 1))).toBe("site_unreadable");
    expect(await listSiteVersions(alice.client, studio.id)).toEqual([]);
    expect(
      await codeOf(() => getPublishedSite(anonClient(), studio.slug)),
    ).toBe("site_not_published");
  });
});
