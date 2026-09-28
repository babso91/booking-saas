import { beforeAll, describe, expect, it } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { getBusinessContext } from "@/features/businesses/data/business-context";
import { listPublicServices } from "@/features/businesses/data/public-business";
import {
  createService,
  deleteService,
  getService,
  listServices,
  reorderServices,
  setServiceActive,
  updateService,
} from "@/features/services/data/services";
import { createServiceSchema } from "@/features/services/schemas/service";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  anonClient,
  createBusiness,
  createProfessional,
  createService as createServiceRow,
  dateInDays,
  db,
  everyDay,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

let owner: Professional;
let intruder: Professional;
let business: TestBusiness;
let foreignBusiness: TestBusiness;

beforeAll(async () => {
  [owner, intruder] = await Promise.all([
    createProfessional("services-owner"),
    createProfessional("services-intruder"),
  ]);
  business = await createBusiness(owner.userId);
  foreignBusiness = await createBusiness(intruder.userId);
});

describe("business context", () => {
  it("resolves the tenant from the session", async () => {
    await expect(getBusinessContext(owner.client)).resolves.toEqual({
      userId: owner.userId,
      businessId: business.id,
      timezone: "Europe/Paris",
    });
  });

  it("refuses anonymous callers and users without business", async () => {
    const lonely = await createProfessional("services-lonely");

    await expect(getBusinessContext(anonClient())).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(getBusinessContext(lonely.client)).rejects.toMatchObject({
      code: "no_business",
    });
  });
});

describe("services CRUD", () => {
  it("creates services with integer cents and appends them in display order", async () => {
    const first = await createService(
      owner.client,
      business.id,
      createServiceSchema.parse({
        name: "  Pose cil à cil ",
        durationMinutes: 120,
        priceCents: 8900,
      }),
    );
    const second = await createService(
      owner.client,
      business.id,
      createServiceSchema.parse({
        name: "Remplissage",
        description: "3 semaines",
        durationMinutes: 60,
        priceCents: 4500,
      }),
    );

    expect(first).toMatchObject({
      name: "Pose cil à cil",
      description: null,
      priceCents: 8900,
      active: true,
      displayOrder: 0,
    });
    expect(second).toMatchObject({
      description: "3 semaines",
      displayOrder: 1,
    });
    expect(await getService(owner.client, business.id, first.id)).toEqual(
      first,
    );
  });

  it("refuses non-integer prices at the schema and database levels", async () => {
    expect(
      createServiceSchema.safeParse({
        name: "Float",
        durationMinutes: 30,
        priceCents: 12.5,
      }).success,
    ).toBe(false);

    const { error } = await owner.client.from("services").insert({
      business_id: business.id,
      name: "Float",
      duration_minutes: 30,
      price_cents: 12.5,
    });
    expect(error?.code).toBe("22P02");

    const { error: negative } = await owner.client.from("services").insert({
      business_id: business.id,
      name: "Negative",
      duration_minutes: 30,
      price_cents: -1,
    });
    expect(negative?.code).toBe("23514");
  });

  it("updates a service", async () => {
    const service = await createService(
      owner.client,
      business.id,
      createServiceSchema.parse({
        name: "Dépose",
        durationMinutes: 30,
        priceCents: 2000,
      }),
    );

    const updated = await updateService(owner.client, business.id, service.id, {
      priceCents: 2500,
      durationMinutes: 45,
      description: null,
    });

    expect(updated).toMatchObject({
      name: "Dépose",
      priceCents: 2500,
      durationMinutes: 45,
    });
  });

  it("reorders all services atomically", async () => {
    const services = await listServices(owner.client, business.id);
    const reversed = services.map((service) => service.id).reverse();

    const reordered = await reorderServices(
      owner.client,
      business.id,
      reversed,
    );

    expect(reordered.map((service) => service.id)).toEqual(reversed);
    expect(reordered.map((service) => service.displayOrder)).toEqual(
      reversed.map((_, index) => index),
    );

    await expect(
      reorderServices(owner.client, business.id, reversed.slice(1)),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("deactivation hides a service publicly and makes it unbookable", async () => {
    const date = dateInDays(10);
    await setWeeklyHours(business.id, everyDay(["09:00", "18:00"]));
    const service = await createService(
      owner.client,
      business.id,
      createServiceSchema.parse({
        name: "Rehaussement",
        durationMinutes: 60,
        priceCents: 5500,
      }),
    );

    await setServiceActive(owner.client, business.id, service.id, false);

    const publicServices = await listPublicServices(
      anonClient(),
      business.slug,
    );
    expect(publicServices.map((s) => s.id)).not.toContain(service.id);
    await expect(
      createPublicBooking(anonClient(), {
        slug: business.slug,
        serviceId: service.id,
        startsAt: zonedLocalToUtc(
          `${date}T10:00`,
          "Europe/Paris",
        ).toISOString(),
        firstName: "Léa",
        email: "lea@example.test",
      }),
    ).rejects.toMatchObject({ code: "service_not_found" });

    await setServiceActive(owner.client, business.id, service.id, true);
    expect(
      (await listPublicServices(anonClient(), business.slug)).map((s) => s.id),
    ).toContain(service.id);
  });

  it("deletes an unused service but refuses to delete a booked one", async () => {
    const unused = await createService(
      owner.client,
      business.id,
      createServiceSchema.parse({
        name: "Temporaire",
        durationMinutes: 30,
        priceCents: 0,
      }),
    );
    await deleteService(owner.client, business.id, unused.id);
    await expect(
      getService(owner.client, business.id, unused.id),
    ).rejects.toMatchObject({
      code: "not_found",
    });

    const booked = await createService(
      owner.client,
      business.id,
      createServiceSchema.parse({
        name: "Réservée",
        durationMinutes: 60,
        priceCents: 1000,
      }),
    );
    await createPublicBooking(anonClient(), {
      slug: business.slug,
      serviceId: booked.id,
      startsAt: zonedLocalToUtc(
        `${dateInDays(12)}T09:00`,
        "Europe/Paris",
      ).toISOString(),
      firstName: "Léa",
      email: "booked@example.test",
    });

    await expect(
      deleteService(owner.client, business.id, booked.id),
    ).rejects.toMatchObject({
      code: "in_use",
    });
  });
});

describe("services of another tenant", () => {
  it("are invisible and immutable, even when the business id is forged", async () => {
    const foreignService = await createServiceRow(foreignBusiness.id, {
      name: "Privé",
    });

    // Forged business id + known service id: RLS returns nothing.
    await expect(
      getService(owner.client, foreignBusiness.id, foreignService),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      listServices(owner.client, foreignBusiness.id),
    ).resolves.toEqual([]);
    await expect(
      updateService(owner.client, foreignBusiness.id, foreignService, {
        priceCents: 1,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      setServiceActive(owner.client, foreignBusiness.id, foreignService, false),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteService(owner.client, foreignBusiness.id, foreignService),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      reorderServices(owner.client, foreignBusiness.id, [foreignService]),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createService(
        owner.client,
        foreignBusiness.id,
        createServiceSchema.parse({
          name: "Intrus",
          durationMinutes: 30,
          priceCents: 0,
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const { rows } = await db.query(
      "select name, price_cents, active from public.services where business_id = $1",
      [foreignBusiness.id],
    );
    expect(rows).toEqual([{ name: "Privé", price_cents: 6500, active: true }]);
  });
});
