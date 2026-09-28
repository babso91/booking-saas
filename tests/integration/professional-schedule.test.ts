import { beforeAll, describe, expect, it } from "vitest";

import {
  createAvailabilityException,
  deleteAvailabilityException,
  getBookingSettings,
  listAvailabilityExceptions,
  listBusinessHours,
  replaceBusinessHours,
  updateAvailabilityException,
  updateBookingSettings,
} from "@/features/availability/data/schedule";
import { getAvailableSlots } from "@/features/availability/data/slots";
import {
  createAvailabilityExceptionSchema,
  replaceBusinessHoursSchema,
} from "@/features/availability/schemas/availability";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  anonClient,
  createBusiness,
  createProfessional,
  createService,
  db,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

let owner: Professional;
let intruder: Professional;
let business: TestBusiness;
let foreign: TestBusiness;

beforeAll(async () => {
  [owner, intruder] = await Promise.all([
    createProfessional("schedule-owner"),
    createProfessional("schedule-intruder"),
  ]);
  // A non-Paris business: nothing may silently assume Europe/Paris.
  business = await createBusiness(owner.userId, {
    timezone: "America/New_York",
  });
  foreign = await createBusiness(intruder.userId);
});

describe("weekly hours", () => {
  it("replaces the whole schedule, with several ranges per day and closed days", async () => {
    const hours = await replaceBusinessHours(
      owner.client,
      business.id,
      replaceBusinessHoursSchema.parse({
        hours: [
          { weekday: 2, startsAt: "10:00", endsAt: "13:00" },
          { weekday: 2, startsAt: "14:00", endsAt: "19:00" },
          { weekday: 6, startsAt: "20:00", endsAt: "24:00" },
        ],
      }),
    );

    expect(
      hours.map((range) => ({
        weekday: range.weekday,
        startsAt: range.startsAt,
        endsAt: range.endsAt,
      })),
    ).toEqual([
      { weekday: 2, startsAt: "10:00", endsAt: "13:00" },
      { weekday: 2, startsAt: "14:00", endsAt: "19:00" },
      { weekday: 6, startsAt: "20:00", endsAt: "24:00" },
    ]);
    expect(await listBusinessHours(owner.client, business.id)).toEqual(hours);
  });

  it("rejects overlapping ranges atomically, keeping the previous schedule", async () => {
    const before = await listBusinessHours(owner.client, business.id);

    expect(
      replaceBusinessHoursSchema.safeParse({
        hours: [
          { weekday: 1, startsAt: "10:00", endsAt: "13:00" },
          { weekday: 1, startsAt: "12:00", endsAt: "15:00" },
        ],
      }).success,
    ).toBe(false);

    // Same payload sent straight to the database function.
    await expect(
      replaceBusinessHours(owner.client, business.id, {
        hours: [
          { weekday: 1, startsAt: "10:00", endsAt: "13:00" },
          { weekday: 1, startsAt: "12:00", endsAt: "15:00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(await listBusinessHours(owner.client, business.id)).toEqual(before);
  });

  it("refuses to replace the schedule of another business", async () => {
    await expect(
      replaceBusinessHours(owner.client, foreign.id, { hours: [] }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("booking settings", () => {
  it("exist by default and can be updated", async () => {
    expect(await getBookingSettings(owner.client, business.id)).toEqual({
      currency: "EUR",
      slotIntervalMinutes: 15,
      bufferMinutes: 0,
      minimumBookingNoticeMinutes: 120,
      maximumBookingAdvanceDays: 90,
    });

    expect(
      await updateBookingSettings(owner.client, business.id, {
        bufferMinutes: 10,
        maximumBookingAdvanceDays: 60,
      }),
    ).toMatchObject({ bufferMinutes: 10, maximumBookingAdvanceDays: 60 });
  });

  it("are protected by database constraints and RLS", async () => {
    await expect(
      updateBookingSettings(owner.client, business.id, {
        bufferMinutes: 10_000,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      updateBookingSettings(owner.client, foreign.id, { bufferMinutes: 5 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("availability exceptions", () => {
  const context = () => ({
    businessId: business.id,
    timezone: business.timezone,
  });

  it("stores local wall-clock times of the business zone as UTC instants", async () => {
    const created = await createAvailabilityException(
      owner.client,
      context(),
      createAvailabilityExceptionSchema.parse({
        kind: "closed",
        startsAt: "2031-07-01T00:00",
        endsAt: "2031-07-08T00:00",
        reason: "Vacances",
      }),
    );

    // New York is UTC−4 in July.
    expect(created).toMatchObject({
      kind: "closed",
      startsAt: "2031-07-01T04:00:00.000Z",
      endsAt: "2031-07-08T04:00:00.000Z",
      localStartsAt: "2031-07-01T00:00",
      localEndsAt: "2031-07-08T00:00",
      reason: "Vacances",
    });

    const listed = await listAvailabilityExceptions(
      owner.client,
      context(),
      new Date("2031-01-01T00:00:00Z"),
    );
    expect(listed).toEqual([created]);
  });

  it("updates and deletes exceptions", async () => {
    const created = await createAvailabilityException(owner.client, context(), {
      kind: "blocked",
      startsAt: "2031-08-01T12:00",
      endsAt: "2031-08-01T14:00",
      reason: null,
    });

    const updated = await updateAvailabilityException(
      owner.client,
      context(),
      created.id,
      {
        kind: "blocked",
        startsAt: "2031-08-01T12:30",
        endsAt: "2031-08-01T15:00",
        reason: "Rendez-vous personnel",
      },
    );
    expect(updated).toMatchObject({
      startsAt: "2031-08-01T16:30:00.000Z",
      reason: "Rendez-vous personnel",
    });

    await deleteAvailabilityException(owner.client, business.id, created.id);
    await expect(
      deleteAvailabilityException(owner.client, business.id, created.id),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("an exceptional opening makes a closed day bookable", async () => {
    const service = await createService(business.id);
    await updateBookingSettings(owner.client, business.id, {
      minimumBookingNoticeMinutes: 0,
      maximumBookingAdvanceDays: 365,
    });
    await replaceBusinessHours(owner.client, business.id, { hours: [] });

    const date = new Date(Date.now() + 20 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const query = { slug: business.slug, serviceId: service, date };

    expect(await getAvailableSlots(anonClient(), query)).toEqual([]);

    await createAvailabilityException(owner.client, context(), {
      kind: "open_override",
      startsAt: `${date}T09:00`,
      endsAt: `${date}T10:30`,
      reason: null,
    });

    // 60-minute service, 15-minute grid, open 09:00–10:30 New York time.
    const slots = await getAvailableSlots(anonClient(), query);
    expect(slots.map((slot) => slot.startsAt)).toEqual(
      ["09:00", "09:15", "09:30"].map((time) =>
        zonedLocalToUtc(`${date}T${time}`, "America/New_York").toISOString(),
      ),
    );
  });

  it("cannot touch the exceptions of another business", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
       values ($1, 'blocked', '2031-09-01T10:00Z', '2031-09-01T11:00Z') returning id`,
      [foreign.id],
    );
    const foreignContext = {
      businessId: foreign.id,
      timezone: foreign.timezone,
    };

    await expect(
      listAvailabilityExceptions(owner.client, foreignContext, new Date(0)),
    ).resolves.toEqual([]);
    await expect(
      updateAvailabilityException(owner.client, foreignContext, rows[0]!.id, {
        kind: "closed",
        startsAt: "2031-09-01T00:00",
        endsAt: "2031-09-02T00:00",
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteAvailabilityException(owner.client, foreign.id, rows[0]!.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createAvailabilityException(owner.client, foreignContext, {
        kind: "closed",
        startsAt: "2031-09-01T00:00",
        endsAt: "2031-09-02T00:00",
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("business time zone", () => {
  it("can be changed by the owner to a valid IANA zone only", async () => {
    const invalid = await owner.client
      .from("businesses")
      .update({ timezone: "Europe/Atlantis" })
      .eq("id", business.id);
    expect(invalid.error?.message).toBe("invalid_timezone");

    const valid = await owner.client
      .from("businesses")
      .update({ timezone: "Asia/Tokyo" })
      .eq("id", business.id)
      .select("timezone")
      .single();
    expect(valid.data).toEqual({ timezone: "Asia/Tokyo" });

    await owner.client
      .from("businesses")
      .update({ timezone: business.timezone })
      .eq("id", business.id);
  });
});
