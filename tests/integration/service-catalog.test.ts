import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { getAvailableSlots } from "@/features/availability/data/slots";
import {
  createCategory,
  deleteCategory,
  getCatalog,
  getCatalogService,
  getPublicCatalog,
  quotePublicService,
  reorderCategories,
  setServiceOptions,
  updateCategory,
  type CatalogServiceDto,
} from "@/features/catalog/data/catalog";
import {
  quote,
  type OptionChoice,
  type ServiceOption,
} from "@/features/catalog/model";
import type { SetServiceOptionsInput } from "@/features/catalog/schemas";
import {
  createService as createServiceData,
  updateService,
} from "@/features/services/data/services";
import { createServiceSchema } from "@/features/services/schemas/service";
import { AppException } from "@/lib/errors";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  addException,
  anonClient,
  bookingClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  randomIp,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
} from "./support/transactions";

// The catalogue (supabase/migrations/20261103090000_service_catalog.sql):
// categories, options and the one pricing rule (private.quote_options) used
// by public slots, public booking and the agenda. Real sessions, real RLS,
// real database functions; the public booking through its data layer (the
// service role, as the route does).

const DATE = dateInDays(16);
const at = (time: string, date = DATE) =>
  zonedLocalToUtc(`${date}T${time}`, "Europe/Paris").toISOString();

let alice: Professional;
let bruno: Professional;
let studioA: TestBusiness;
let studioB: TestBusiness;

beforeAll(async () => {
  [alice, bruno] = await Promise.all([
    createProfessional("catalog-alice"),
    createProfessional("catalog-bruno"),
  ]);
  studioA = await createBusiness(alice.userId, {
    settings: { slot_interval_minutes: 15, buffer_minutes: 0 },
  });
  studioB = await createBusiness(bruno.userId, {
    settings: { slot_interval_minutes: 15, buffer_minutes: 0 },
  });
  await setWeeklyHours(studioA.id, everyDay(["09:00", "18:00"]));
  await setWeeklyHours(studioB.id, everyDay(["09:00", "18:00"]));
});

/** A fresh business of Alice's, open 09:00–18:00 every day. */
async function freshStudio(settings: Record<string, number> = {}) {
  const studio = await createBusiness(alice.userId, {
    settings: { slot_interval_minutes: 15, buffer_minutes: 0, ...settings },
  });
  await setWeeklyHours(studio.id, everyDay(["09:00", "18:00"]));
  return studio;
}

type Options = SetServiceOptionsInput["options"];

async function withOptions(
  pro: Professional,
  businessId: string,
  serviceId: string,
  options: Options,
): Promise<CatalogServiceDto> {
  const current = await getCatalogService(pro.client, businessId, serviceId);
  return setServiceOptions(pro.client, businessId, {
    serviceId,
    expectedVersion: current.version,
    options,
  });
}

/** "Dépose ?" (optional) and "Longueur" (required): the lab's kind of options. */
const lashOptions: Options = [
  {
    question: "Longueur",
    required: true,
    choices: [
      { label: "Naturelle", priceDeltaCents: 0, durationDeltaMinutes: 0 },
      { label: "Volume", priceDeltaCents: 1500, durationDeltaMinutes: 30 },
    ],
  },
  {
    question: "Dépose de l’ancienne pose ?",
    required: false,
    choices: [
      { label: "Oui", priceDeltaCents: 1000, durationDeltaMinutes: 15 },
    ],
  },
];

const choiceId = (service: CatalogServiceDto, label: string) =>
  service.options
    .flatMap((option) => option.choices)
    .find((choice) => choice.label === label)!.id;

async function book(
  business: TestBusiness,
  serviceId: string,
  time: string,
  extra: {
    optionChoiceIds?: string[];
    expectedPriceCents?: number;
    expectedDurationMinutes?: number;
    requestId?: string;
    email?: string;
  } = {},
) {
  return createPublicBooking(
    bookingClient(),
    {
      slug: business.slug,
      serviceId,
      startsAt: at(time),
      firstName: "Léa",
      email: extra.email ?? `lea-${randomUUID().slice(0, 8)}@test.local`,
      requestId: extra.requestId ?? randomUUID(),
      optionChoiceIds: extra.optionChoiceIds,
      expectedPriceCents: extra.expectedPriceCents,
      expectedDurationMinutes: extra.expectedDurationMinutes,
    },
    randomIp(),
  );
}

async function codeOf(run: () => Promise<unknown>) {
  try {
    await run();
    return "ok";
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
}

async function appointmentRow(id: string) {
  const { rows } = await db.query(
    `select service_name_snapshot, price_cents_snapshot,
            duration_minutes_snapshot, options_snapshot,
            extract(epoch from ends_at - starts_at)::int / 60 as minutes
     from public.appointments where id = $1`,
    [id],
  );
  return rows[0];
}

const appointmentCount = async (businessId: string) =>
  Number(
    (
      await db.query(
        "select count(*) from public.appointments where business_id = $1",
        [businessId],
      )
    ).rows[0].count,
  );

// ---------------------------------------------------------------------------

describe("categories", () => {
  it("are hers to create, rename, hide, order and delete; none is imposed", async () => {
    const studio = await freshStudio();
    expect((await getCatalog(alice.client, studio.id)).categories).toEqual([]);

    const requestId = randomUUID();
    const cils = await createCategory(alice.client, studio.id, {
      name: "  Cils  ",
      visible: true,
      requestId,
    });
    expect(cils).toMatchObject({ name: "Cils", visible: true, version: 1 });
    // A retry answers the same category; another command under the same id
    // is refused.
    expect(
      await createCategory(alice.client, studio.id, {
        name: "Cils",
        visible: true,
        requestId,
      }),
    ).toEqual(cils);
    expect(
      await codeOf(() =>
        createCategory(alice.client, studio.id, {
          name: "Henné",
          visible: true,
          requestId,
        }),
      ),
    ).toBe("idempotency_conflict");

    const henne = await createCategory(alice.client, studio.id, {
      name: "Henné",
      visible: true,
      requestId: randomUUID(),
    });
    expect(henne.displayOrder).toBe(1);

    const renamed = await updateCategory(alice.client, studio.id, {
      categoryId: cils.id,
      expectedVersion: cils.version,
      name: "Regard",
    });
    expect(renamed).toMatchObject({ name: "Regard", version: 2 });
    // A retry of the same edit, from the old version: answered as it is.
    expect(
      await updateCategory(alice.client, studio.id, {
        categoryId: cils.id,
        expectedVersion: cils.version,
        name: "Regard",
      }),
    ).toEqual(renamed);
    // Another edit from the old version: refused, nothing written.
    expect(
      await codeOf(() =>
        updateCategory(alice.client, studio.id, {
          categoryId: cils.id,
          expectedVersion: cils.version,
          visible: false,
        }),
      ),
    ).toBe("stale_category");

    expect(
      (
        await reorderCategories(alice.client, studio.id, [henne.id, cils.id])
      ).map((category) => category.name),
    ).toEqual(["Henné", "Regard"]);
    expect(
      await codeOf(() =>
        reorderCategories(alice.client, studio.id, [henne.id]),
      ),
    ).toBe("validation_error");

    // Deleting a category keeps its services, without a category.
    const service = await createServiceData(
      alice.client,
      studio.id,
      createServiceSchema.parse({
        requestId: randomUUID(),
        name: "Rehaussement",
        durationMinutes: 60,
        priceCents: 5000,
        categoryId: henne.id,
      }),
    );
    expect(service.categoryId).toBe(henne.id);
    await deleteCategory(alice.client, studio.id, henne.id);
    const after = await getCatalog(alice.client, studio.id);
    expect(after.categories.map((category) => category.name)).toEqual([
      "Regard",
    ]);
    expect(after.services[0]).toMatchObject({
      id: service.id,
      categoryId: null,
      version: service.version + 1,
    });
    expect(
      await codeOf(() => deleteCategory(alice.client, studio.id, henne.id)),
    ).toBe("category_not_found");
  });

  it("a creation retried after its category was deleted is not recreated", async () => {
    const studio = await freshStudio();
    const requestId = randomUUID();
    const category = await createCategory(alice.client, studio.id, {
      name: "Ongles",
      visible: true,
      requestId,
    });
    await deleteCategory(alice.client, studio.id, category.id);
    expect(
      await codeOf(() =>
        createCategory(alice.client, studio.id, {
          name: "Ongles",
          visible: true,
          requestId,
        }),
      ),
    ).toBe("category_deleted");
    expect((await getCatalog(alice.client, studio.id)).categories).toEqual([]);
  });

  it("services may have no category, and move between hers", async () => {
    const studio = await freshStudio();
    const category = await createCategory(alice.client, studio.id, {
      name: "Sourcils",
      visible: true,
      requestId: randomUUID(),
    });
    const loose = await createServiceData(
      alice.client,
      studio.id,
      createServiceSchema.parse({
        requestId: randomUUID(),
        name: "Retouche",
        durationMinutes: 15,
        priceCents: 0,
      }),
    );
    expect(loose.categoryId).toBeNull();
    const moved = await updateService(
      alice.client,
      studio.id,
      loose.id,
      { categoryId: category.id },
      loose.version,
    );
    expect(moved).toMatchObject({
      categoryId: category.id,
      version: loose.version + 1,
    });
    const back = await updateService(
      alice.client,
      studio.id,
      loose.id,
      { categoryId: null },
      moved.version,
    );
    expect(back.categoryId).toBeNull();
  });
});

describe("isolation between businesses", () => {
  it("another business's categories and options are neither readable nor writable", async () => {
    const category = await createCategory(alice.client, studioA.id, {
      name: "Privée",
      visible: true,
      requestId: randomUUID(),
    });
    const serviceA = await createService(studioA.id, { name: "Pose A" });
    const optioned = await withOptions(
      alice,
      studioA.id,
      serviceA,
      lashOptions,
    );
    const serviceB = await createService(studioB.id, { name: "Pose B" });

    // Reads: RLS shows nothing of Alice's to Bruno.
    for (const table of [
      "service_categories",
      "service_options",
      "service_option_choices",
    ] as const) {
      const { data, error } = await bruno.client
        .from(table)
        .select("id")
        .eq("business_id", studioA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    expect(await codeOf(() => getCatalog(bruno.client, studioA.id))).toBe(
      "forbidden",
    );

    // Writes through the functions: refused, nothing changed.
    const refused = [
      () =>
        createCategory(bruno.client, studioA.id, {
          name: "Intrus",
          visible: true,
          requestId: randomUUID(),
        }),
      () =>
        updateCategory(bruno.client, studioA.id, {
          categoryId: category.id,
          expectedVersion: category.version,
          visible: false,
        }),
      () => reorderCategories(bruno.client, studioA.id, [category.id]),
      () => deleteCategory(bruno.client, studioA.id, category.id),
      () =>
        setServiceOptions(bruno.client, studioA.id, {
          serviceId: serviceA,
          expectedVersion: optioned.version,
          options: [],
        }),
    ];
    for (const run of refused) expect(await codeOf(run)).toBe("forbidden");

    // His own business, her ids: they do not exist there.
    expect(
      await codeOf(() =>
        updateCategory(bruno.client, studioB.id, {
          categoryId: category.id,
          expectedVersion: category.version,
          visible: false,
        }),
      ),
    ).toBe("category_not_found");
    expect(
      await codeOf(() => deleteCategory(bruno.client, studioB.id, category.id)),
    ).toBe("category_not_found");
    expect(
      await codeOf(() =>
        createServiceData(
          bruno.client,
          studioB.id,
          createServiceSchema.parse({
            requestId: randomUUID(),
            name: "Pose",
            durationMinutes: 60,
            priceCents: 1000,
            categoryId: category.id,
          }),
        ),
      ),
    ).toBe("category_not_found");
    const serviceBRead = await getCatalogService(
      bruno.client,
      studioB.id,
      serviceB,
    );
    expect(
      await codeOf(() =>
        updateService(
          bruno.client,
          studioB.id,
          serviceB,
          { categoryId: category.id },
          serviceBRead.version,
        ),
      ),
    ).toBe("category_not_found");
    expect(
      await codeOf(() =>
        setServiceOptions(bruno.client, studioB.id, {
          serviceId: serviceA,
          expectedVersion: optioned.version,
          options: [],
        }),
      ),
    ).toBe("service_not_found");
    // Her answer ids inside his own options document: refused.
    expect(
      await codeOf(() =>
        setServiceOptions(bruno.client, studioB.id, {
          serviceId: serviceB,
          expectedVersion: serviceBRead.version,
          options: optioned.options.map((option) => ({
            ...option,
            choices: option.choices,
          })),
        }),
      ),
    ).toBe("validation_error");

    // No direct writes to the new tables, for anyone through the API.
    for (const client of [alice.client, bruno.client, anonClient()]) {
      const insert = await client.from("service_categories").insert({
        business_id: studioA.id,
        name: "Directe",
      });
      expect(insert.error).not.toBeNull();
      const update = await client
        .from("service_option_choices")
        .update({ price_delta_cents: 0 })
        .eq("business_id", studioA.id)
        .select("id");
      expect(update.error).not.toBeNull();
    }

    // Unchanged.
    const catalog = await getCatalog(alice.client, studioA.id);
    expect(catalog.categories.find((c) => c.id === category.id)).toEqual(
      category,
    );
    expect(catalog.services.find((s) => s.id === serviceA)!.options).toEqual(
      optioned.options,
    );
  });

  it("an answer of another business's service never prices a booking", async () => {
    const serviceA = await createService(studioA.id, { name: "Avec options" });
    const optioned = await withOptions(
      alice,
      studioA.id,
      serviceA,
      lashOptions,
    );
    const serviceB = await createService(studioB.id, { name: "Sans options" });
    expect(
      await codeOf(() =>
        book(studioB, serviceB, "10:00", {
          optionChoiceIds: [choiceId(optioned, "Volume")],
        }),
      ),
    ).toBe("option_choice_unavailable");
  });
});

describe("options", () => {
  it("are kept by id, replaced as a whole, and change the service's version", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 90,
      priceCents: 6000,
    });
    const first = await withOptions(alice, studio.id, serviceId, lashOptions);
    expect(first.options.map((option) => option.question)).toEqual([
      "Longueur",
      "Dépose de l’ancienne pose ?",
    ]);
    expect(first.version).toBe(2);

    // Edit: a price changes, the optional group goes, a new answer comes.
    const [longueur, depose] = first.options as [ServiceOption, ServiceOption];
    const second = await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: first.version,
      // The optional group goes: deleted on purpose.
      deletedOptionIds: [depose.id],
      options: [
        {
          id: longueur.id,
          question: "Longueur",
          required: true,
          choices: [
            { ...longueur.choices[0]! },
            { ...longueur.choices[1]!, priceDeltaCents: 2000 },
            {
              label: "Mega volume",
              priceDeltaCents: 3500,
              durationDeltaMinutes: 60,
            },
          ],
        },
      ],
    });
    expect(second.version).toBe(3);
    expect(second.options).toHaveLength(1);
    expect(second.options[0]!.id).toBe(longueur.id);
    expect(
      second.options[0]!.choices.map((choice) => choice.id).slice(0, 2),
    ).toEqual(longueur.choices.map((choice) => choice.id));
    expect(second.options[0]!.choices[1]!.priceDeltaCents).toBe(2000);

    // Another editor still at version 2: refused, nothing written.
    expect(
      await codeOf(() =>
        setServiceOptions(alice.client, studio.id, {
          serviceId,
          expectedVersion: first.version,
          options: [],
        }),
      ),
    ).toBe("stale_service");
    // The same request retried after its answer was lost: answered as it is.
    const retried = await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: first.version,
      // The optional group goes: deleted on purpose.
      deletedOptionIds: [depose.id],
      options: [
        {
          id: longueur.id,
          question: "Longueur",
          required: true,
          choices: [
            { ...longueur.choices[0]! },
            { ...longueur.choices[1]!, priceDeltaCents: 2000 },
            {
              label: "Mega volume",
              priceDeltaCents: 3500,
              durationDeltaMinutes: 60,
            },
          ],
        },
      ],
    });
    expect(retried).toEqual(second);

    // An answer moved to another group, or an id given twice: refused.
    expect(
      await codeOf(() =>
        setServiceOptions(alice.client, studio.id, {
          serviceId,
          expectedVersion: second.version,
          options: [
            {
              question: "Autre",
              required: false,
              choices: [{ ...second.options[0]!.choices[0]! }],
            },
          ],
        }),
      ),
    ).toBe("validation_error");

    // Never longer than 12 h with its longest answers.
    expect(
      await codeOf(() =>
        setServiceOptions(alice.client, studio.id, {
          serviceId,
          expectedVersion: second.version,
          deletedOptionIds: [longueur.id],
          options: [0, 1, 2].map((index) => ({
            question: `Étape ${index}`,
            required: true,
            choices: [
              { label: "Oui", priceDeltaCents: 0, durationDeltaMinutes: 240 },
            ],
          })),
        }),
      ),
    ).toBe("validation_error");
    // Nor by lengthening the service itself afterwards (90 + 60 → 680 + 60).
    expect(
      await codeOf(() =>
        updateService(
          alice.client,
          studio.id,
          serviceId,
          { durationMinutes: 680 },
          second.version,
        ),
      ),
    ).toBe("validation_error");

    // Removing every option.
    const none = await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: second.version,
      options: [],
      deletedOptionIds: [longueur.id],
    });
    expect(none.options).toEqual([]);
    const { rows } = await db.query(
      "select count(*)::int as n from public.service_option_choices where option_id = $1",
      [longueur.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("nothing is specific to a trade: three unrelated catalogues", async () => {
    for (const [category, service, options] of [
      ["Cils", "Rehaussement", [["Teinture ?", false, [["Oui", 1000, 15]]]]],
      [
        "Henné",
        "Tatouage main",
        [
          [
            "Taille",
            true,
            [
              ["Petit", 0, 0],
              ["Grand", 2500, 45],
            ],
          ],
        ],
      ],
      [
        "Épilation",
        "Jambes",
        [
          [
            "Zone",
            true,
            [
              ["Demi", 0, 0],
              ["Complètes", 1500, 20],
            ],
          ],
          ["Aisselles ?", false, [["Oui", 800, 10]]],
        ],
      ],
    ] as const) {
      const studio = await freshStudio();
      const created = await createCategory(alice.client, studio.id, {
        name: category,
        visible: true,
        requestId: randomUUID(),
      });
      const serviceId = (
        await createServiceData(
          alice.client,
          studio.id,
          createServiceSchema.parse({
            requestId: randomUUID(),
            name: service,
            durationMinutes: 30,
            priceCents: 3000,
            categoryId: created.id,
          }),
        )
      ).id;
      await withOptions(
        alice,
        studio.id,
        serviceId,
        options.map(([question, required, choices]) => ({
          question,
          required,
          choices: choices.map(
            ([label, priceDeltaCents, durationDeltaMinutes]) => ({
              label,
              priceDeltaCents,
              durationDeltaMinutes,
            }),
          ),
        })),
      );
      const catalog = await getPublicCatalog(anonClient(), studio.slug);
      expect(catalog!.groups).toHaveLength(1);
      expect(catalog!.groups[0]!.category!.name).toBe(category);
      expect(catalog!.groups[0]!.services[0]!.options).toHaveLength(
        options.length,
      );
    }
  });
});

describe("the public catalogue", () => {
  it("visible categories in her order with their bookable services, then those without one", async () => {
    const studio = await freshStudio();
    const make = (name: string, visible = true) =>
      createCategory(alice.client, studio.id, {
        name,
        visible,
        requestId: randomUUID(),
      });
    const regard = await make("Regard");
    const ongles = await make("Ongles");
    const cachee = await make("Cachée", false);
    const vide = await make("Vide");
    void vide;
    await reorderCategories(alice.client, studio.id, [
      ongles.id,
      regard.id,
      cachee.id,
      vide.id,
    ]);
    const add = async (
      name: string,
      categoryId: string | null,
      active = true,
    ) =>
      (
        await createServiceData(
          alice.client,
          studio.id,
          createServiceSchema.parse({
            requestId: randomUUID(),
            name,
            durationMinutes: 60,
            priceCents: 4000,
            active,
            categoryId,
          }),
        )
      ).id;
    await add("Pose cils", regard.id);
    await add("Gel", ongles.id);
    const hidden = await add("Secret", cachee.id);
    await add("Ancienne", regard.id, false);
    const loose = await add("Consultation", null);

    const catalog = await getPublicCatalog(anonClient(), studio.slug);
    expect(
      catalog!.groups.map((group) => [
        group.category?.name ?? null,
        group.services.map((service) => service.name),
      ]),
    ).toEqual([
      ["Ongles", ["Gel"]],
      ["Regard", ["Pose cils"]],
      [null, ["Consultation"]],
    ]);
    expect(catalog!.currency).toBe("EUR");
    expect(await getPublicCatalog(anonClient(), "nobody-here")).toBeNull();

    // A hidden category's service is not bookable online at all…
    const { data: listed } = await anonClient().rpc("get_public_services", {
      p_slug: studio.slug,
    });
    expect(listed!.map((service) => service.name).sort()).toEqual([
      "Consultation",
      "Gel",
      "Pose cils",
    ]);
    expect(
      await codeOf(() =>
        getAvailableSlots(anonClient(), {
          slug: studio.slug,
          serviceId: hidden,
          date: DATE,
        }),
      ),
    ).toBe("service_not_found");
    expect(await codeOf(() => book(studio, hidden, "10:00"))).toBe(
      "service_not_found",
    );
    // …while she can still book it herself in her agenda.
    const { error } = await alice.client.rpc("agenda_create_appointment", {
      p_business_id: studio.id,
      p_service_id: hidden,
      p_starts_at: at("10:00"),
      p_client_first_name: "Inès",
    });
    expect(error).toBeNull();
    // Showing the category again makes it bookable.
    await updateCategory(alice.client, studio.id, {
      categoryId: cachee.id,
      expectedVersion: cachee.version,
      visible: true,
    });
    expect(await codeOf(() => book(studio, hidden, "11:00"))).toBe("ok");
    void loose;
  });
});

describe("price and duration are the server's", () => {
  it("the answers are priced by the database, whatever the browser believes", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    const volume = choiceId(service, "Volume");
    const depose = choiceId(service, "Oui");

    expect(
      await quotePublicService(anonClient(), studio.slug, serviceId, [
        volume,
        depose,
      ]),
    ).toMatchObject({ priceCents: 8500, durationMinutes: 105 });

    const booked = await book(studio, serviceId, "10:00", {
      optionChoiceIds: [depose, volume],
    });
    expect(booked).toMatchObject({ priceCents: 8500, durationMinutes: 105 });
    expect(Date.parse(booked.endsAt) - Date.parse(booked.startsAt)).toBe(
      105 * 60_000,
    );
    expect(booked.options.map((option) => option.label)).toEqual([
      "Volume",
      "Oui",
    ]);
    expect(await appointmentRow(booked.appointmentId)).toMatchObject({
      price_cents_snapshot: 8500,
      duration_minutes_snapshot: 105,
      minutes: 105,
    });

    // What a screen computes is exactly what the server answers, for every
    // combination (including the refused ones).
    const ids = service.options.flatMap((option) =>
      option.choices.map((c) => c.id),
    );
    const combinations = [
      [],
      ...ids.map((id) => [id]),
      ...ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => [a, b])),
    ];
    for (const combination of combinations) {
      const local = quote(service, combination);
      const remote = await codeOf(() =>
        quotePublicService(anonClient(), studio.slug, serviceId, combination),
      );
      if (local.ok) {
        const answer = await quotePublicService(
          anonClient(),
          studio.slug,
          serviceId,
          combination,
        );
        expect([answer.priceCents, answer.durationMinutes]).toEqual([
          local.priceCents,
          local.durationMinutes,
        ]);
      } else {
        expect(remote).toBe(
          local.reason === "invalid_options"
            ? "validation_error"
            : local.reason,
        );
      }
    }
  });

  it("refuses missing, foreign or contradictory answers without writing anything", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    const otherId = await createService(studio.id, { name: "Autre" });
    const other = await withOptions(alice, studio.id, otherId, lashOptions);
    const before = await appointmentCount(studio.id);

    expect(await codeOf(() => book(studio, serviceId, "10:00"))).toBe(
      "options_required",
    );
    expect(
      await codeOf(() =>
        book(studio, serviceId, "10:00", {
          optionChoiceIds: [choiceId(service, "Oui")],
        }),
      ),
    ).toBe("options_required");
    expect(
      await codeOf(() =>
        book(studio, serviceId, "10:00", {
          optionChoiceIds: [
            choiceId(service, "Naturelle"),
            choiceId(service, "Volume"),
          ],
        }),
      ),
    ).toBe("validation_error");
    expect(
      await codeOf(() =>
        book(studio, serviceId, "10:00", {
          optionChoiceIds: [choiceId(other, "Volume")],
        }),
      ),
    ).toBe("option_choice_unavailable");
    expect(
      await codeOf(() =>
        book(studio, serviceId, "10:00", { optionChoiceIds: [randomUUID()] }),
      ),
    ).toBe("option_choice_unavailable");
    expect(
      await codeOf(() =>
        getAvailableSlots(anonClient(), {
          slug: studio.slug,
          serviceId,
          date: DATE,
        }),
      ),
    ).toBe("options_required");
    expect(await appointmentCount(studio.id)).toBe(before);

    // An optional group left unanswered adds nothing.
    const plain = await book(studio, serviceId, "10:00", {
      optionChoiceIds: [choiceId(service, "Naturelle")],
    });
    expect(plain).toMatchObject({ priceCents: 6000, durationMinutes: 60 });
  });

  it("what she was shown is checked when the client says it", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    const volume = choiceId(service, "Volume");
    const before = await appointmentCount(studio.id);
    for (const shown of [
      { expectedPriceCents: 6000 },
      { expectedDurationMinutes: 60 },
      { expectedPriceCents: 7500, expectedDurationMinutes: 60 },
    ]) {
      expect(
        await codeOf(() =>
          book(studio, serviceId, "10:00", {
            optionChoiceIds: [volume],
            ...shown,
          }),
        ),
      ).toBe("quote_changed");
    }
    expect(await appointmentCount(studio.id)).toBe(before);
    expect(
      await book(studio, serviceId, "10:00", {
        optionChoiceIds: [volume],
        expectedPriceCents: 7500,
        expectedDurationMinutes: 90,
      }),
    ).toMatchObject({ priceCents: 7500, durationMinutes: 90 });
  });
});

describe("a catalogue changed between reading and booking", () => {
  async function setup() {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    return { studio, serviceId, service };
  }

  it("a deleted answer: refused; a new price: booked at the new price, or refused if she was shown the old", async () => {
    const { studio, serviceId, service } = await setup();
    const volume = choiceId(service, "Volume");
    const shown = quote(service, [volume]);

    // The price of "Volume" goes up after the page was read.
    const [longueur, depose] = service.options as [
      ServiceOption,
      ServiceOption,
    ];
    const raised = await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: service.version,
      options: [
        {
          ...longueur,
          choices: [
            longueur.choices[0]!,
            { ...longueur.choices[1]!, priceDeltaCents: 2500 },
          ],
        },
        depose,
      ],
    });
    expect(
      await codeOf(() =>
        book(studio, serviceId, "10:00", {
          optionChoiceIds: [volume],
          expectedPriceCents: shown.ok ? shown.priceCents : -1,
        }),
      ),
    ).toBe("quote_changed");
    expect(
      await book(studio, serviceId, "10:00", { optionChoiceIds: [volume] }),
    ).toMatchObject({ priceCents: 8500 });

    // "Volume" is removed.
    const removed = await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: raised.version,
      options: [{ ...longueur, choices: [longueur.choices[0]!] }, depose],
      deletedChoiceIds: [volume],
    });
    expect(
      await codeOf(() =>
        book(studio, serviceId, "12:00", { optionChoiceIds: [volume] }),
      ),
    ).toBe("option_choice_unavailable");

    // A new required group appears.
    await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: removed.version,
      options: [
        { ...longueur, choices: [longueur.choices[0]!] },
        depose,
        {
          question: "Courbure",
          required: true,
          choices: [
            { label: "C", priceDeltaCents: 0, durationDeltaMinutes: 0 },
          ],
        },
      ],
    });
    expect(
      await codeOf(() =>
        book(studio, serviceId, "12:00", {
          optionChoiceIds: [longueur.choices[0]!.id],
        }),
      ),
    ).toBe("options_required");
  });

  it("a change committed while a booking waits for the schedule is seen by it", async () => {
    const { studio, serviceId, service } = await setup();
    const volume = choiceId(service, "Volume");
    const [longueur, depose] = service.options as [
      ServiceOption,
      ServiceOption,
    ];

    // Her edit holds the schedule lock (uncommitted) while a booking arrives.
    const edit = await openTransaction({
      role: "authenticated",
      userId: alice.userId,
    });
    await edit.connection.query(
      "select public.set_service_options($1, $2, $3, $4::jsonb, '{}'::uuid[], $5::uuid[])",
      [
        studio.id,
        serviceId,
        service.version,
        JSON.stringify([
          {
            id: longueur.id,
            question: "Longueur",
            required: true,
            choices: [longueur.choices[0]],
          },
          {
            id: depose.id,
            question: depose.question,
            required: false,
            choices: depose.choices,
          },
        ]),
        [volume],
      ],
    );
    const tag = randomUUID();
    const booking = outcome(
      db.query(
        `select * from private.create_public_booking_at(now(), $1, $2, $3, 'Léa',
           '${tag}@test.local', null, null, $4, null, $5::uuid[])`,
        [studio.slug, serviceId, at("10:00"), randomUUID(), [volume]],
      ),
    );
    const { rows } = await db.query<{ pid: number }>(
      `select pid from pg_stat_activity where query like $1 and pid <> pg_backend_pid()`,
      [`%${tag}%`],
    );
    await waitUntilBlocked(rows[0]!.pid);
    await closeTransaction(edit, "commit");
    expect(await booking).toBe("option_choice_unavailable");
    expect(await appointmentCount(studio.id)).toBe(0);
  });
});

describe("a category hidden while a booking arrives", () => {
  it("the booking waits for her change and then sees it", async () => {
    const studio = await freshStudio();
    const category = await createCategory(alice.client, studio.id, {
      name: "Regard",
      visible: true,
      requestId: randomUUID(),
    });
    const serviceId = (
      await createServiceData(
        alice.client,
        studio.id,
        createServiceSchema.parse({
          requestId: randomUUID(),
          name: "Pose",
          durationMinutes: 60,
          priceCents: 6000,
          categoryId: category.id,
        }),
      )
    ).id;

    const hide = await openTransaction({
      role: "authenticated",
      userId: alice.userId,
    });
    await hide.connection.query(
      "select * from public.update_service_category($1, $2, $3, null, false)",
      [studio.id, category.id, category.version],
    );
    const tag = randomUUID();
    const booking = outcome(
      db.query(
        `select * from private.create_public_booking_at(now(), $1, $2, $3, 'Léa',
           '${tag}@test.local', null, null, $4, null, '{}'::uuid[])`,
        [studio.slug, serviceId, at("10:00"), randomUUID()],
      ),
    );
    const { rows } = await db.query<{ pid: number }>(
      `select pid from pg_stat_activity where query like $1 and pid <> pg_backend_pid()`,
      [`%${tag}%`],
    );
    await waitUntilBlocked(rows[0]!.pid);
    await closeTransaction(hide, "commit");
    expect(await booking).toBe("service_not_found");
    expect(await appointmentCount(studio.id)).toBe(0);
  });
});

describe("history", () => {
  it("an appointment keeps what was agreed, whatever happens to the catalogue", async () => {
    const studio = await freshStudio();
    const category = await createCategory(alice.client, studio.id, {
      name: "Regard",
      visible: true,
      requestId: randomUUID(),
    });
    const serviceId = (
      await createServiceData(
        alice.client,
        studio.id,
        createServiceSchema.parse({
          requestId: randomUUID(),
          name: "Pose",
          durationMinutes: 60,
          priceCents: 6000,
          categoryId: category.id,
        }),
      )
    ).id;
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    const booked = await book(studio, serviceId, "10:00", {
      optionChoiceIds: [choiceId(service, "Volume"), choiceId(service, "Oui")],
    });
    const agreed = await appointmentRow(booked.appointmentId);
    expect(agreed).toMatchObject({
      service_name_snapshot: "Pose",
      price_cents_snapshot: 8500,
      duration_minutes_snapshot: 105,
      minutes: 105,
    });
    expect(agreed.options_snapshot).toEqual([
      expect.objectContaining({
        question: "Longueur",
        label: "Volume",
        priceDeltaCents: 1500,
        durationDeltaMinutes: 30,
      }),
      expect.objectContaining({
        question: "Dépose de l’ancienne pose ?",
        label: "Oui",
        priceDeltaCents: 1000,
        durationDeltaMinutes: 15,
      }),
    ]);

    // Everything changes: prices, labels, options, name, category.
    const current = await getCatalogService(alice.client, studio.id, serviceId);
    const renamed = await updateService(
      alice.client,
      studio.id,
      serviceId,
      { name: "Pose 2027", priceCents: 9000, durationMinutes: 45 },
      current.version,
    );
    await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: renamed.version,
      options: [],
      deletedOptionIds: current.options.map((option) => option.id),
    });
    await deleteCategory(alice.client, studio.id, category.id);

    expect(await appointmentRow(booked.appointmentId)).toEqual(agreed);
  });
});

describe("clients written before options", () => {
  it("a service without options books exactly as before; retries are answered, never booked twice", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 45,
      priceCents: 3500,
    });
    const requestId = randomUUID();
    const email = "ancienne@test.local";
    // The request as an existing client sends it: no option field at all.
    const input = {
      slug: studio.slug,
      serviceId,
      startsAt: at("10:00"),
      firstName: "Léa",
      email,
      requestId,
    };
    const first = await createPublicBooking(bookingClient(), input, randomIp());
    expect(first).toMatchObject({
      priceCents: 3500,
      durationMinutes: 45,
      options: [],
      replayed: false,
    });
    const again = await createPublicBooking(bookingClient(), input, randomIp());
    expect(again).toMatchObject({
      appointmentId: first.appointmentId,
      replayed: true,
    });
    expect(await appointmentRow(first.appointmentId)).toMatchObject({
      price_cents_snapshot: 3500,
      duration_minutes_snapshot: 45,
      options_snapshot: [],
    });

    // Its idempotency fingerprint is the one it had before options existed:
    // an in-flight request from before the migration replays, not conflicts.
    const { rows } = await db.query(
      `select creation_request_fingerprint = encode(sha256(convert_to(
         jsonb_build_object('kind', 'public_booking', 'service_id', service_id,
           'starts_at', extract(epoch from starts_at), 'first_name', 'Léa',
           'last_name', null, 'email', $2::text, 'phone', null)::text, 'UTF8')), 'hex') as same
       from public.appointments where id = $1`,
      [first.appointmentId, email],
    );
    expect(rows[0].same).toBe(true);

    // The former listing and slots are unchanged for it.
    const slots = await getAvailableSlots(anonClient(), {
      slug: studio.slug,
      serviceId,
      date: DATE,
    });
    expect(slots[0]).toMatchObject({ localStartsAt: `${DATE}T09:00` });
  });

  it("with answers, the same request id replays; other answers under it conflict", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    const requestId = randomUUID();
    const email = "retry@test.local";
    const first = await book(studio, serviceId, "10:00", {
      requestId,
      email,
      optionChoiceIds: [choiceId(service, "Volume"), choiceId(service, "Oui")],
    });
    // Same answers in another order: the same request.
    const again = await book(studio, serviceId, "10:00", {
      requestId,
      email,
      optionChoiceIds: [choiceId(service, "Oui"), choiceId(service, "Volume")],
    });
    expect(again).toMatchObject({
      appointmentId: first.appointmentId,
      replayed: true,
      priceCents: 8500,
      options: first.options,
    });
    expect(
      await codeOf(() =>
        book(studio, serviceId, "10:00", {
          requestId,
          email,
          optionChoiceIds: [choiceId(service, "Volume")],
        }),
      ),
    ).toBe("idempotency_conflict");
    expect(await appointmentCount(studio.id)).toBe(1);
  });
});

describe("availability with the total duration", () => {
  it("slots fit the service plus its answers, the appointments and their buffers, and closures", async () => {
    const studio = await freshStudio({ buffer_minutes: 15 });
    await setWeeklyHours(studio.id, everyDay(["09:00", "13:00"]));
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, [
      {
        question: "Durée",
        required: false,
        choices: [
          { label: "Longue", priceDeltaCents: 0, durationDeltaMinutes: 30 },
        ],
      },
    ]);
    const longue = choiceId(service, "Longue");
    // An appointment 11:00–12:00 (with its 15-minute buffer: busy until 12:15).
    const clientId = await createClientRecord(studio.id, "busy@test.local");
    await db.query(
      `insert into public.appointments (business_id, client_id, service_id, starts_at, ends_at,
         service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, buffer_minutes_snapshot)
       values ($1, $2, $3, $4, $5, 'Pose', 60, 6000, 15)`,
      [studio.id, clientId, serviceId, at("11:00"), at("12:00")],
    );
    await addException(studio.id, "closed", at("12:30"), at("12:45"));

    const local = async (ids: string[]) =>
      (
        await getAvailableSlots(anonClient(), {
          slug: studio.slug,
          serviceId,
          date: DATE,
          optionChoiceIds: ids,
        })
      ).map((slot) => slot.localStartsAt.slice(11));

    // 60 min + 15 buffer before 11:00: up to 09:45. After 12:15, 60 min do
    // not fit before the closure at 12:30, nor after it before 13:00.
    expect(await local([])).toEqual(["09:00", "09:15", "09:30", "09:45"]);
    // 90 min + 15 buffer before 11:00: up to 09:15.
    expect(await local([longue])).toEqual(["09:00", "09:15"]);
    // The booking re-validates with the same total.
    expect(
      await codeOf(() =>
        book(studio, serviceId, "09:30", { optionChoiceIds: [longue] }),
      ),
    ).toBe("slot_unavailable");
    expect(
      await book(studio, serviceId, "09:15", { optionChoiceIds: [longue] }),
    ).toMatchObject({ durationMinutes: 90 });
  });

  it("across a change of time, the total is real minutes", async () => {
    // Europe/Paris, 2027-03-28: 02:00 jumps to 03:00. Open 00:00–06:00 that
    // night (5 real hours), a 60-minute service with a 60-minute answer.
    const studio = await freshStudio({
      maximum_booking_advance_days: 365,
      minimum_booking_notice_minutes: 0,
      slot_interval_minutes: 60,
    });
    await setWeeklyHours(studio.id, everyDay(["00:00", "06:00"]));
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, [
      {
        question: "Durée",
        required: true,
        choices: [
          { label: "Double", priceDeltaCents: 2000, durationDeltaMinutes: 60 },
        ],
      },
    ]);
    const now = "2027-03-01T08:00:00Z";
    const { rows } = await db.query<{ starts_at: Date; ends_at: Date }>(
      `select starts_at, ends_at
       from private.available_slots($1, $2, '2027-03-28'::date, $3::timestamptz, $4::uuid[])`,
      [studio.id, serviceId, now, [choiceId(service, "Double")]],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const slot of rows) {
      expect(slot.ends_at.getTime() - slot.starts_at.getTime()).toBe(
        120 * 60_000,
      );
    }
    // 00:00 local is 23:00Z; the night has 5 real hours: starts every real
    // hour from 23:00Z to 02:00Z.
    expect(rows.map((slot) => slot.starts_at.toISOString())).toEqual([
      "2027-03-27T23:00:00.000Z",
      "2027-03-28T00:00:00.000Z",
      "2027-03-28T01:00:00.000Z",
      "2027-03-28T02:00:00.000Z",
    ]);
    const { rows: booked } = await db.query(
      `select price_cents, duration_minutes, ends_at
       from private.create_public_booking_at($1::timestamptz, $2, $3, $4::timestamptz,
         'Léa', 'dst@test.local', null, null, $5, null, $6::uuid[])`,
      [
        now,
        studio.slug,
        serviceId,
        "2027-03-28T00:00:00Z",
        randomUUID(),
        [choiceId(service, "Double")],
      ],
    );
    expect(booked[0]).toMatchObject({
      price_cents: 8000,
      duration_minutes: 120,
    });
    expect(booked[0].ends_at.toISOString()).toBe("2027-03-28T02:00:00.000Z");
  });
});

describe("concurrent bookings with options", () => {
  it("two bookings of overlapping slots: one is booked, the other refused", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    // 10:00 + 90 min overlaps 11:00.
    const results = await Promise.allSettled([
      book(studio, serviceId, "10:00", {
        optionChoiceIds: [choiceId(service, "Volume")],
      }),
      book(studio, serviceId, "11:00", {
        optionChoiceIds: [choiceId(service, "Naturelle")],
      }),
      book(studio, serviceId, "10:00", {
        optionChoiceIds: [choiceId(service, "Naturelle")],
      }),
    ]);
    const booked = results.filter((result) => result.status === "fulfilled");
    const refused = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => (result.reason as AppException).code);
    expect(refused.every((code) => code === "slot_unavailable")).toBe(true);
    const { rows } = await db.query(
      `select count(*)::int as n from public.appointments a, public.appointments b
       where a.business_id = $1 and b.business_id = $1 and a.id < b.id
         and a.occupied_window && b.occupied_window`,
      [studio.id],
    );
    expect(rows[0].n).toBe(0);
    expect(booked.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the agenda: the same rule for her own bookings", () => {
  async function setup() {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      durationMinutes: 60,
      priceCents: 6000,
    });
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    return { studio, serviceId, service };
  }

  async function create(
    studio: TestBusiness,
    serviceId: string,
    time: string,
    ids?: string[],
    requestId?: string,
  ) {
    const { data, error } = await alice.client
      .rpc("agenda_create_appointment", {
        p_business_id: studio.id,
        p_service_id: serviceId,
        p_starts_at: at(time),
        p_client_first_name: "Inès",
        p_option_choice_ids: ids,
        p_request_id: requestId,
      })
      .single();
    return {
      id: data?.appointment_id,
      created: data?.created,
      error: error?.message,
    };
  }

  async function edit(
    id: string,
    changes: { serviceId: string; time?: string; ids?: string[] },
  ) {
    const { rows } = await db.query(
      "select version, client_id from public.appointments where id = $1",
      [id],
    );
    const { error } = await alice.client.rpc("agenda_update_appointment", {
      p_business_id: (
        await db.query(
          "select business_id from public.appointments where id = $1",
          [id],
        )
      ).rows[0].business_id,
      p_appointment_id: id,
      p_expected_version: rows[0].version,
      p_service_id: changes.serviceId,
      p_client_id: rows[0].client_id,
      p_starts_at: changes.time ? at(changes.time) : undefined,
      p_option_choice_ids: changes.ids,
    });
    return error?.message ?? "ok";
  }

  it("creation: priced by the same rule; required answers enforced; retries answered", async () => {
    const { studio, serviceId, service } = await setup();
    expect((await create(studio, serviceId, "10:00")).error).toBe(
      "options_required",
    );
    const requestId = randomUUID();
    const made = await create(
      studio,
      serviceId,
      "10:00",
      [choiceId(service, "Volume")],
      requestId,
    );
    expect(made).toMatchObject({ created: true });
    expect(await appointmentRow(made.id!)).toMatchObject({
      price_cents_snapshot: 7500,
      duration_minutes_snapshot: 90,
      minutes: 90,
    });
    expect(
      await create(
        studio,
        serviceId,
        "10:00",
        [choiceId(service, "Volume")],
        requestId,
      ),
    ).toMatchObject({
      id: made.id,
      created: false,
    });
    expect(
      (
        await create(
          studio,
          serviceId,
          "10:00",
          [choiceId(service, "Naturelle")],
          requestId,
        )
      ).error,
    ).toBe("idempotency_conflict");
    // Without options, a service is created exactly as before.
    const plainId = await createService(studio.id, {
      durationMinutes: 30,
      priceCents: 2000,
    });
    const plain = await create(studio, plainId, "15:00");
    expect(await appointmentRow(plain.id!)).toMatchObject({
      price_cents_snapshot: 2000,
      duration_minutes_snapshot: 30,
      options_snapshot: [],
    });
  });

  it("edition: moving keeps what was agreed; other answers or another service are priced now", async () => {
    const { studio, serviceId, service } = await setup();
    const made = await create(studio, serviceId, "10:00", [
      choiceId(service, "Volume"),
    ]);
    const agreed = await appointmentRow(made.id!);

    // The catalogue's prices change.
    const [longueur, depose] = service.options as [
      ServiceOption,
      ServiceOption,
    ];
    const raised = await setServiceOptions(alice.client, studio.id, {
      serviceId,
      expectedVersion: service.version,
      options: [
        {
          ...longueur,
          choices: [
            longueur.choices[0]!,
            { ...longueur.choices[1]!, priceDeltaCents: 3000 },
          ],
        },
        depose,
      ],
    });
    // Moved (answers absent, or the same ones again): unchanged price.
    expect(await edit(made.id!, { serviceId, time: "14:00" })).toBe("ok");
    expect(
      await edit(made.id!, {
        serviceId,
        time: "15:00",
        ids: [choiceId(service, "Volume")],
      }),
    ).toBe("ok");
    expect(await appointmentRow(made.id!)).toEqual(agreed);

    // Other answers: priced now (new price of the answers chosen).
    expect(
      await edit(made.id!, {
        serviceId,
        ids: [choiceId(service, "Volume"), choiceId(service, "Oui")],
      }),
    ).toBe("ok");
    expect(await appointmentRow(made.id!)).toMatchObject({
      price_cents_snapshot: 6000 + 3000 + 1000,
      duration_minutes_snapshot: 105,
      minutes: 105,
    });
    void raised;

    // Another service with required options, without answers: refused.
    const otherId = await createService(studio.id, {
      name: "Autre",
      durationMinutes: 30,
      priceCents: 3000,
    });
    await withOptions(alice, studio.id, otherId, lashOptions);
    expect(await edit(made.id!, { serviceId: otherId })).toBe(
      "options_required",
    );
    // A deleted answer: refused.
    expect(await edit(made.id!, { serviceId, ids: [randomUUID()] })).toBe(
      "option_choice_unavailable",
    );

    // A finished appointment's answers cannot change.
    await db.query(
      "update public.appointments set status = 'completed' where id = $1",
      [made.id],
    );
    expect(
      await edit(made.id!, {
        serviceId,
        ids: [choiceId(service, "Naturelle")],
      }),
    ).toBe("appointment_not_editable");
    expect(await edit(made.id!, { serviceId })).toBe("ok");
  });
});

describe("a catalogue larger than one API page (PostgREST max_rows = 1000)", () => {
  // 51 services × 20 answers = 1 020 answers: more than one page.
  let studio: TestBusiness;
  let services: string[];

  const twenty = (prefix: string) => [
    {
      question: "Teinte",
      required: true,
      choices: Array.from({ length: 20 }, (_, index) => ({
        label: `${prefix} ${index + 1}`,
        priceDeltaCents: index * 100,
        durationDeltaMinutes: 0,
      })),
    },
  ];

  beforeAll(async () => {
    studio = await freshStudio();
    services = [];
    for (let index = 0; index < 51; index += 1) {
      const id = await createService(studio.id, {
        name: `Prestation ${index + 1}`,
      });
      await withOptions(alice, studio.id, id, twenty(`R${index + 1}`));
      services.push(id);
    }
  }, 120_000);

  it("is read whole: every answer of every service", async () => {
    const { count } = await alice.client
      .from("service_option_choices")
      .select("id", { count: "exact", head: true })
      .eq("business_id", studio.id);
    expect(count).toBe(1020);
    // A plain table read stops at one page (what the catalogue read did).
    const { data: page } = await alice.client
      .from("service_option_choices")
      .select("id")
      .eq("business_id", studio.id);
    expect(page!.length).toBe(1000);

    const catalog = await getCatalog(alice.client, studio.id);
    expect(catalog.services).toHaveLength(51);
    for (const service of catalog.services) {
      expect(service.options[0]!.choices).toHaveLength(20);
    }
    const one = await getCatalogService(alice.client, studio.id, services[50]!);
    expect(one.options[0]!.choices).toHaveLength(20);
  });

  it("an answer left out without being deleted is refused, nothing written", async () => {
    const service = await getCatalogService(
      alice.client,
      studio.id,
      services[50]!,
    );
    const [option] = service.options as [ServiceOption];
    expect(
      await codeOf(() =>
        setServiceOptions(alice.client, studio.id, {
          serviceId: service.id,
          expectedVersion: service.version,
          options: [{ ...option, choices: option.choices.slice(0, 19) }],
        }),
      ),
    ).toBe("options_incomplete");
    // A whole group left out without being deleted: refused too.
    expect(
      await codeOf(() =>
        setServiceOptions(alice.client, studio.id, {
          serviceId: service.id,
          expectedVersion: service.version,
          options: [],
        }),
      ),
    ).toBe("options_incomplete");
    expect(
      await getCatalogService(alice.client, studio.id, service.id),
    ).toEqual(service);
  });

  it("deleting and replacing on purpose are done exactly as asked", async () => {
    const service = await getCatalogService(
      alice.client,
      studio.id,
      services[49]!,
    );
    const [option] = service.options as [ServiceOption];
    const last = option.choices[19]!;
    const deleted = await setServiceOptions(alice.client, studio.id, {
      serviceId: service.id,
      expectedVersion: service.version,
      options: [{ ...option, choices: option.choices.slice(0, 19) }],
      deletedChoiceIds: [last.id],
    });
    expect(deleted.options[0]!.choices.map((choice) => choice.id)).toEqual(
      option.choices.slice(0, 19).map((choice) => choice.id),
    );
    const replaced = await setServiceOptions(alice.client, studio.id, {
      serviceId: service.id,
      expectedVersion: deleted.version,
      options: [
        {
          question: "Nouvelle question",
          required: false,
          choices: [
            { label: "Seule", priceDeltaCents: 0, durationDeltaMinutes: 0 },
          ],
        },
      ],
      deletedOptionIds: [option.id],
    });
    expect(replaced.options).toEqual([
      expect.objectContaining({
        question: "Nouvelle question",
        required: false,
      }),
    ]);
    // A retry of that request, once applied: answered as it is.
    expect(
      await setServiceOptions(alice.client, studio.id, {
        serviceId: service.id,
        expectedVersion: deleted.version,
        options: [
          {
            question: "Nouvelle question",
            required: false,
            choices: [
              { label: "Seule", priceDeltaCents: 0, durationDeltaMinutes: 0 },
            ],
          },
        ],
        deletedOptionIds: [option.id],
      }),
    ).toEqual(replaced);
  });
});

describe("ids are compared as uuids", () => {
  it("the same answer id in another case is the same id: refused before any write", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id);
    const service = await withOptions(alice, studio.id, serviceId, lashOptions);
    const [longueur, depose] = service.options as [
      ServiceOption,
      ServiceOption,
    ];
    const [naturelle, volume] = longueur.choices as [
      OptionChoice,
      OptionChoice,
    ];
    const { error } = await alice.client.rpc("set_service_options", {
      p_business_id: studio.id,
      p_service_id: serviceId,
      p_expected_version: service.version,
      p_options: [
        {
          ...longueur,
          choices: [
            { ...naturelle, id: naturelle.id.toUpperCase() },
            { ...naturelle, id: naturelle.id.toLowerCase(), label: "Doublon" },
            volume,
          ],
        },
        depose,
      ],
    });
    expect(error?.message).toBe("invalid_options");
    // The same group id twice, in two spellings.
    const twice = await alice.client.rpc("set_service_options", {
      p_business_id: studio.id,
      p_service_id: serviceId,
      p_expected_version: service.version,
      p_options: [
        { ...longueur, id: longueur.id.toUpperCase() },
        {
          id: longueur.id.toLowerCase(),
          question: "Doublon",
          required: false,
          choices: [
            { label: "Nouvelle", priceDeltaCents: 0, durationDeltaMinutes: 0 },
          ],
        },
        depose,
      ],
    });
    expect(twice.error?.message).toBe("invalid_options");
    expect(await getCatalogService(alice.client, studio.id, serviceId)).toEqual(
      service,
    );
  });
});

describe("the total price fits what an appointment can store", () => {
  const MAX = 2_147_483_647;

  it("options that would overflow it are refused when written", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, {
      priceCents: MAX - 1000,
    });
    expect(
      await codeOf(() =>
        withOptions(alice, studio.id, serviceId, [
          {
            question: "Supplément",
            required: false,
            choices: [
              { label: "Oui", priceDeltaCents: 1001, durationDeltaMinutes: 0 },
            ],
          },
        ]),
      ),
    ).toBe("validation_error");
    // Exactly at the limit: accepted, and booked without overflow.
    const fits = await withOptions(alice, studio.id, serviceId, [
      {
        question: "Supplément",
        required: false,
        choices: [
          { label: "Oui", priceDeltaCents: 1000, durationDeltaMinutes: 0 },
        ],
      },
    ]);
    expect(
      await quotePublicService(anonClient(), studio.slug, serviceId, [
        choiceId(fits, "Oui"),
      ]),
    ).toMatchObject({ priceCents: MAX });
  });

  it("raising the service's price past it, with options, is refused", async () => {
    const studio = await freshStudio();
    const serviceId = await createService(studio.id, { priceCents: 5000 });
    const service = await withOptions(alice, studio.id, serviceId, [
      {
        question: "Supplément",
        required: false,
        choices: [
          { label: "Oui", priceDeltaCents: 5000, durationDeltaMinutes: 0 },
        ],
      },
    ]);
    const { error } = await db
      .query("update public.services set price_cents = $2 where id = $1", [
        serviceId,
        MAX - 4999,
      ])
      .then(
        () => ({ error: null }),
        (caught: { message: string }) => ({ error: caught.message }),
      );
    expect(error).toBe("price_too_high");
    expect(
      (await getCatalogService(alice.client, studio.id, serviceId)).priceCents,
    ).toBe(5000);
    void service;
  });
});
