import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPublicBooking } from "@/features/appointments/data/public-booking";
import { createPublicBookingSchema } from "@/features/appointments/schemas/public-booking";
import { getAvailableSlots } from "@/features/availability/data/slots";
import {
  getPublicBusiness,
  listPublicServices,
} from "@/features/businesses/data/public-business";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  addException,
  anonClient,
  createBusiness,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  setWeeklyHours,
  updateSettings,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// Public booking flow through the real DAL functions and the anonymous
// Supabase client used by the Route Handlers. Dates are relative to the real
// clock because the RPCs use now().

const DATE = dateInDays(14);
const client = anonClient();

let owner: Professional;
let business: TestBusiness;
let service: string;

function local(time: string, date = DATE, timezone = business.timezone) {
  return zonedLocalToUtc(`${date}T${time}`, timezone).toISOString();
}

function booking(
  overrides: Partial<
    Parameters<typeof createPublicBookingSchema.parse>[0]
  > = {},
) {
  return createPublicBookingSchema.parse({
    slug: business.slug,
    serviceId: service,
    startsAt: local("10:00"),
    firstName: "Léa",
    email: "lea@example.test",
    ...overrides,
  });
}

beforeAll(async () => {
  owner = await createProfessional("booking");
});

beforeEach(async () => {
  business = await createBusiness(owner.userId, {
    name: "Studio Mila Lashes",
    settings: { slot_interval_minutes: 15, buffer_minutes: 0 },
  });
  service = await createService(business.id, {
    name: "Volume mixte",
    durationMinutes: 60,
    priceCents: 8500,
  });
  await setWeeklyHours(
    business.id,
    everyDay(["09:00", "13:00"], ["14:00", "18:00"]),
  );
});

describe("public business and services", () => {
  it("returns the public profile by slug, case-insensitively, without private fields", async () => {
    const profile = await getPublicBusiness(
      client,
      business.slug.toUpperCase(),
    );

    expect(profile).toMatchObject({
      slug: business.slug,
      name: "Studio Mila Lashes",
      timezone: "Europe/Paris",
      currency: "EUR",
    });
    expect(profile).not.toHaveProperty("contactEmail");
    expect(await getPublicBusiness(client, "does-not-exist")).toBeNull();
  });

  it("lists active services only, with integer prices in cents", async () => {
    await createService(business.id, { name: "Dépose", active: false });

    const services = await listPublicServices(client, business.slug);

    expect(services).toEqual([
      {
        id: service,
        name: "Volume mixte",
        description: null,
        durationMinutes: 60,
        priceCents: 8500,
        currency: "EUR",
      },
    ]);
  });
});

describe("booking an available slot", () => {
  it("creates client, appointment and confirmation email in one call", async () => {
    const slots = await getAvailableSlots(client, {
      slug: business.slug,
      serviceId: service,
      date: DATE,
    });
    expect(slots[0]).toEqual({
      startsAt: local("09:00"),
      endsAt: local("10:00"),
    });

    const result = await createPublicBooking(
      client,
      booking({
        startsAt: slots[0]!.startsAt,
        lastName: "Martin",
        email: "  Lea.Martin@Example.TEST ",
        phone: "+33 6 12 34 56 78",
      }),
    );

    expect(result).toMatchObject({
      startsAt: local("09:00"),
      endsAt: local("10:00"),
      timezone: "Europe/Paris",
      serviceName: "Volume mixte",
      durationMinutes: 60,
      priceCents: 8500,
      currency: "EUR",
      businessName: "Studio Mila Lashes",
    });

    const { rows: clients } = await db.query(
      "select first_name, last_name, email, phone from public.clients where business_id = $1",
      [business.id],
    );
    expect(clients).toEqual([
      {
        first_name: "Léa",
        last_name: "Martin",
        email: "lea.martin@example.test",
        phone: "+33 6 12 34 56 78",
      },
    ]);

    const { rows: appointments } = await db.query(
      `select status, service_name_snapshot, price_cents_snapshot, duration_minutes_snapshot
       from public.appointments where id = $1 and business_id = $2`,
      [result.appointmentId, business.id],
    );
    expect(appointments).toEqual([
      {
        status: "confirmed",
        service_name_snapshot: "Volume mixte",
        price_cents_snapshot: 8500,
        duration_minutes_snapshot: 60,
      },
    ]);

    const { rows: emails } = await db.query(
      `select type, status, recipient_email, dedupe_key, payload->>'business_slug' as slug
       from public.email_events where appointment_id = $1`,
      [result.appointmentId],
    );
    expect(emails).toEqual([
      {
        type: "booking_confirmation",
        status: "pending",
        recipient_email: "lea.martin@example.test",
        dedupe_key: `booking_confirmation:${result.appointmentId}`,
        slug: business.slug,
      },
    ]);

    const after = await getAvailableSlots(client, {
      slug: business.slug,
      serviceId: service,
      date: DATE,
    });
    expect(after.map((slot) => slot.startsAt)).not.toContain(local("09:00"));
  });

  it("works with the minimal required fields (first name + email)", async () => {
    const result = await createPublicBooking(client, booking());

    expect(result.startsAt).toBe(local("10:00"));
  });
});

describe("rejections", () => {
  it("rejects an inactive service", async () => {
    await db.query("update public.services set active = false where id = $1", [
      service,
    ]);

    await expect(
      getAvailableSlots(client, {
        slug: business.slug,
        serviceId: service,
        date: DATE,
      }),
    ).rejects.toMatchObject({ code: "service_not_found" });
    await expect(createPublicBooking(client, booking())).rejects.toMatchObject({
      code: "service_not_found",
    });
  });

  it("rejects a service of another business", async () => {
    const other = await createBusiness(owner.userId);
    const foreign = await createService(other.id);

    await expect(
      createPublicBooking(client, booking({ serviceId: foreign })),
    ).rejects.toMatchObject({ code: "service_not_found" });
  });

  it("rejects an unknown business", async () => {
    await expect(
      createPublicBooking(client, booking({ slug: "nobody-here" })),
    ).rejects.toMatchObject({ code: "business_not_found" });
  });

  it.each([
    ["before opening", "08:00"],
    ["during the lunch break", "13:30"],
    ["overlapping closing time", "17:30"],
    ["after closing", "19:00"],
    ["off the slot grid", "10:07"],
  ])("rejects a slot %s", async (_label, time) => {
    await expect(
      createPublicBooking(client, booking({ startsAt: local(time) })),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("rejects a slot inside a blocked period", async () => {
    await addException(business.id, "blocked", local("10:30"), local("11:00"));

    await expect(
      createPublicBooking(client, booking({ startsAt: local("10:00") })),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(
      createPublicBooking(client, booking({ startsAt: local("11:00") })),
    ).resolves.toMatchObject({ startsAt: local("11:00") });
  });

  it("rejects a slot during holidays", async () => {
    await addException(
      business.id,
      "closed",
      local("00:00"),
      local("00:00", dateInDays(16)),
    );

    await expect(createPublicBooking(client, booking())).rejects.toMatchObject({
      code: "slot_unavailable",
    });
  });

  it("rejects slots in the past, within the minimum notice or beyond the horizon", async () => {
    await updateSettings(business.id, { maximum_booking_advance_days: 7 });

    await expect(
      createPublicBooking(
        client,
        booking({ startsAt: local("10:00", dateInDays(-1)) }),
      ),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(createPublicBooking(client, booking())).rejects.toMatchObject({
      code: "slot_unavailable",
    });

    await updateSettings(business.id, {
      maximum_booking_advance_days: 60,
      minimum_booking_notice_minutes: 60 * 24 * 7,
    });
    await expect(
      createPublicBooking(
        client,
        booking({ startsAt: local("10:00", dateInDays(2)) }),
      ),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("takes the service duration into account", async () => {
    const long = await createService(business.id, { durationMinutes: 90 });

    await expect(
      createPublicBooking(
        client,
        booking({ serviceId: long, startsAt: local("11:45") }),
      ),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(
      createPublicBooking(
        client,
        booking({ serviceId: long, startsAt: local("11:30") }),
      ),
    ).resolves.toMatchObject({ endsAt: local("13:00"), durationMinutes: 90 });
  });

  it("rejects an overlap with an existing appointment", async () => {
    await createPublicBooking(client, booking({ startsAt: local("10:00") }));

    for (const time of ["09:15", "10:00", "10:45"]) {
      await expect(
        createPublicBooking(
          client,
          booking({
            startsAt: local(time),
            email: `h${time.replace(":", "")}@x.test`,
          }),
        ),
      ).rejects.toMatchObject({ code: "slot_unavailable" });
    }
    await expect(
      createPublicBooking(
        client,
        booking({ startsAt: local("11:00"), email: "next@x.test" }),
      ),
    ).resolves.toBeDefined();
  });

  it("enforces the buffer between two appointments", async () => {
    await updateSettings(business.id, { buffer_minutes: 30 });
    await createPublicBooking(client, booking({ startsAt: local("10:00") }));

    for (const time of ["08:45", "09:15", "11:00", "11:15"]) {
      await expect(
        createPublicBooking(
          client,
          booking({
            startsAt: local(time),
            email: `h${time.replace(":", "")}@x.test`,
          }),
        ),
      ).rejects.toMatchObject({ code: "slot_unavailable" });
    }
    await expect(
      createPublicBooking(
        client,
        booking({ startsAt: local("11:30"), email: "b@x.test" }),
      ),
    ).resolves.toBeDefined();
    await expect(
      createPublicBooking(
        client,
        booking({ startsAt: local("09:00"), email: "c@x.test" }),
      ),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("re-validates input on the server even when the API is called directly", async () => {
    const { error } = await client.rpc("create_public_booking", {
      p_slug: business.slug,
      p_service_id: service,
      p_starts_at: local("10:00"),
      p_first_name: "  ",
      p_email: "not-an-email",
    });

    expect(error?.message).toBe("invalid_first_name");

    const { error: emailError } = await client.rpc("create_public_booking", {
      p_slug: business.slug,
      p_service_id: service,
      p_starts_at: local("10:00"),
      p_first_name: "Léa",
      p_email: "not-an-email",
    });

    expect(emailError?.message).toBe("invalid_email");
  });
});

describe("cancellation", () => {
  it("frees the slot for another client once cancelled", async () => {
    const first = await createPublicBooking(
      client,
      booking({ email: "first@x.test" }),
    );

    await expect(
      createPublicBooking(client, booking({ email: "second@x.test" })),
    ).rejects.toMatchObject({ code: "slot_unavailable" });

    await db.query(
      "update public.appointments set status = 'cancelled' where id = $1",
      [first.appointmentId],
    );

    await expect(
      createPublicBooking(client, booking({ email: "second@x.test" })),
    ).resolves.toMatchObject({ startsAt: local("10:00") });
  });
});

describe("clients are scoped to their business", () => {
  it("keeps one client per business for the same email, never merged", async () => {
    const other = await createBusiness(owner.userId, {
      settings: { slot_interval_minutes: 15 },
    });
    const otherService = await createService(other.id);
    await setWeeklyHours(other.id, everyDay(["09:00", "18:00"]));

    await createPublicBooking(client, booking({ firstName: "Léa" }));
    await createPublicBooking(
      client,
      booking({ slug: other.slug, serviceId: otherService, firstName: "Lea" }),
    );

    const { rows } = await db.query(
      `select business_id, first_name from public.clients
       where email = 'lea@example.test' and business_id = any($1)
       order by first_name`,
      [[business.id, other.id]],
    );
    expect(rows).toEqual([
      { business_id: other.id, first_name: "Lea" },
      { business_id: business.id, first_name: "Léa" },
    ]);
  });

  it("finds the existing client by email within the business without overwriting it", async () => {
    await createPublicBooking(
      client,
      booking({ firstName: "Léa", phone: "0612345678" }),
    );
    await createPublicBooking(
      client,
      booking({
        startsAt: local("15:00"),
        firstName: "Impostor",
        email: "LEA@EXAMPLE.TEST",
        phone: "0000000000",
      }),
    );

    const { rows } = await db.query(
      `select c.first_name, c.phone, count(a.id)::int as appointments
       from public.clients c join public.appointments a on a.client_id = c.id
       where c.business_id = $1 group by c.id`,
      [business.id],
    );
    expect(rows).toEqual([
      { first_name: "Léa", phone: "0612345678", appointments: 2 },
    ]);
  });
});
