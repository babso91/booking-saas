import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { showcase } from "@/features/catalog/client/catalog-view";
import {
  createCategory,
  getCatalog,
  getCatalogService,
  getPublicCatalog,
  reorderCategories,
  setServiceOptions,
} from "@/features/catalog/data/catalog";

import {
  anonClient,
  createBusiness,
  createProfessional,
  createService,
  db,
} from "./support/fixtures";

// One source of truth: the professional's own reading (get_catalog, what
// the studio and the dashboard show) and what her clients see
// (get_public_catalog, what the mini-site and its universes receive) are
// the same catalogue. The screens compute her clients' view with
// showcase(); here, against PostgreSQL, it must be exactly the server's.

async function place(
  serviceId: string,
  values: { categoryId?: string | null; active?: boolean; order?: number },
) {
  await db.query(
    `update public.services
        set category_id = coalesce($2, category_id),
            active = coalesce($3, active),
            display_order = coalesce($4, display_order)
      where id = $1`,
    [
      serviceId,
      values.categoryId ?? null,
      values.active ?? null,
      values.order ?? null,
    ],
  );
}

async function setUp() {
  const pro = await createProfessional("showcase");
  const business = await createBusiness(pro.userId);
  const category = (name: string, visible = true) =>
    createCategory(pro.client, business.id, {
      name,
      visible,
      requestId: randomUUID(),
    });
  return { pro, business, category };
}

describe("what her clients see is her catalogue", () => {
  it("visible categories in her order, hidden and empty ones left out, the rest last", async () => {
    const { pro, business, category } = await setUp();
    const henne = await category("Henné");
    const masquee = await category("Préparation", false);
    const vide = await category("Bientôt");
    const inactive = await category("Archives");
    const epilation = await category("Épilation");
    // Her order is not the order of creation.
    await reorderCategories(pro.client, business.id, [
      epilation.id,
      vide.id,
      henne.id,
      masquee.id,
      inactive.id,
    ]);

    const motif = await createService(business.id, {
      name: "Motif",
      durationMinutes: 45,
    });
    const mains = await createService(business.id, {
      name: "Mains",
      durationMinutes: 30,
    });
    const jambes = await createService(business.id, {
      name: "Jambes",
      durationMinutes: 40,
    });
    const essai = await createService(business.id, { name: "Essai" });
    const ancien = await createService(business.id, { name: "Ancien" });
    const libre = await createService(business.id, { name: "Libre" });
    const horsLigne = await createService(business.id, { name: "Hors ligne" });
    await place(motif, { categoryId: henne.id, order: 3 });
    await place(mains, { categoryId: henne.id, order: 1 });
    await place(jambes, { categoryId: epilation.id, order: 2 });
    await place(essai, { categoryId: masquee.id });
    await place(ancien, { categoryId: inactive.id, active: false });
    await place(libre, { order: 0 });
    await place(horsLigne, { active: false });

    const current = await getCatalogService(pro.client, business.id, motif);
    await setServiceOptions(pro.client, business.id, {
      serviceId: motif,
      expectedVersion: current.version,
      options: [
        {
          question: "Taille du motif",
          required: true,
          choices: [
            { label: "Fin", priceDeltaCents: 0, durationDeltaMinutes: 0 },
            { label: "Large", priceDeltaCents: 1250, durationDeltaMinutes: 20 },
          ],
        },
        {
          question: "Paillettes ?",
          required: false,
          choices: [
            { label: "Oui", priceDeltaCents: 300, durationDeltaMinutes: 0 },
          ],
        },
      ],
    });

    const hers = await getCatalog(pro.client, business.id);
    const theirs = await getPublicCatalog(anonClient(), business.slug);
    expect(theirs).not.toBeNull();
    expect(showcase(hers.categories, hers.services, theirs!.currency)).toEqual(
      theirs,
    );
    // And it says what we think it says.
    expect(
      theirs!.groups.map((group) => [
        group.category?.name ?? null,
        group.services.map((service) => service.name),
      ]),
    ).toEqual([
      ["Épilation", ["Jambes"]],
      ["Henné", ["Mains", "Motif"]],
      [null, ["Libre"]],
    ]);
  });

  it("no category at all, then an empty catalogue: the same on both sides", async () => {
    const { pro, business } = await setUp();
    await createService(business.id, { name: "Seule" });
    let hers = await getCatalog(pro.client, business.id);
    let theirs = await getPublicCatalog(anonClient(), business.slug);
    expect(showcase(hers.categories, hers.services, theirs!.currency)).toEqual(
      theirs,
    );

    await db.query(
      "update public.services set active = false where business_id = $1",
      [business.id],
    );
    hers = await getCatalog(pro.client, business.id);
    theirs = await getPublicCatalog(anonClient(), business.slug);
    expect(theirs!.groups).toEqual([]);
    expect(showcase(hers.categories, hers.services, theirs!.currency)).toEqual(
      theirs,
    );
  });
});
