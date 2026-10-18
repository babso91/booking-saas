import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAppointmentAction,
  getAgendaAction,
  listAgendaServicesAction,
} from "@/features/agenda/actions/agenda";
import {
  listBusinessHoursAction,
  replaceBusinessHoursAction,
} from "@/features/availability/actions/schedule";
import { getSetupProgress } from "@/features/businesses/data/setup-progress";
import { listClientsAction } from "@/features/crm/actions/crm";
import {
  createServiceAction,
  listServicesAction,
  reorderServicesAction,
  setServiceActiveAction,
  updateServiceAction,
} from "@/features/services/actions/services";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

import {
  createBusiness,
  createProfessional,
  dateInDays,
  db,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";

// A newly onboarded professional configures her services and opening hours
// through the Server Actions the new screens call, against the real stack:
// the settings persist, the agenda books with them, and the CRM sees the
// customer. Only the cookie-based Supabase client is replaced by a client
// signed in as the test professional.

let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ZONE = "America/Vancouver";

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function failure<T>(result: ActionResult<T>, code: AppErrorCode) {
  expect(result).toMatchObject({ ok: false, error: { code } });
}

/** UTC offset of ZONE at noon UTC of `date`. */
function offsetAt(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName")!.value;
}

/**
 * A weekday (Monday to Friday) at least `days` ahead, with no DST change
 * around it in ZONE: the expectations below do not depend on the run date.
 */
function ordinaryWeekday(days: number) {
  for (let offset = days; ; offset += 1) {
    const date = dateInDays(offset);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (
      weekday >= 1 &&
      weekday <= 5 &&
      offsetAt(dateInDays(offset - 1)) === offsetAt(dateInDays(offset + 1))
    ) {
      return date;
    }
  }
}

const DAY = ordinaryWeekday(14);

let owner: Professional;
let intruder: Professional;
let business: TestBusiness;

beforeAll(async () => {
  [owner, intruder] = await Promise.all([
    createProfessional("setup-owner"),
    createProfessional("setup-intruder"),
  ]);
  // Onboarded, nothing configured yet (as complete_onboarding leaves it).
  business = await createBusiness(owner.userId, { timezone: ZONE });
  await createBusiness(intruder.userId);
});

describe("a newly onboarded professional", () => {
  it("starts with nothing to book: no service, no opening hours", async () => {
    sessionClient = owner.client;
    expect(await getSetupProgress(owner.client, business.id)).toEqual({
      activeServices: 0,
      openingRanges: 0,
    });
    expect(ok(await listServicesAction())).toEqual([]);
    expect(ok(await listBusinessHoursAction())).toEqual([]);
    expect(ok(await listAgendaServicesAction()).services).toEqual([]);
  });

  it("configures services and hours that persist, then books with them in the agenda; the CRM sees the customer", async () => {
    sessionClient = owner.client;

    // 1. Three services, as the services screen sends them.
    const commands = [
      {
        name: "Pose cil à cil",
        description: null,
        durationMinutes: 120,
        priceCents: 11000,
      },
      {
        name: "Remplissage",
        description: "Toutes les 3 semaines",
        durationMinutes: 60,
        priceCents: 5500,
      },
      {
        name: "Rehaussement",
        description: null,
        durationMinutes: 75,
        priceCents: 6550,
      },
    ];
    const created = [];
    for (const command of commands) {
      created.push(
        ok(await createServiceAction({ ...command, requestId: randomUUID() })),
      );
    }
    expect(created.map((service) => service.displayOrder)).toEqual([0, 1, 2]);

    // An edit changes only what is sent.
    const edited = ok(
      await updateServiceAction({
        serviceId: created[2]!.id,
        expectedVersion: created[2]!.version,
        changes: { priceCents: 7000 },
      }),
    );
    expect(edited).toMatchObject({
      name: "Rehaussement",
      priceCents: 7000,
      durationMinutes: 75,
    });

    // 2. The whole week, as the hours screen sends it (Sunday closed).
    const week = [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, startsAt: "09:00", endsAt: "12:30" },
      { weekday, startsAt: "13:30", endsAt: "19:00" },
    ]);
    week.push({ weekday: 6, startsAt: "10:00", endsAt: "16:00" });
    ok(await replaceBusinessHoursAction({ hours: week, expected: [] }));

    // 3. Everything is read back as saved (a reload).
    expect(
      ok(await listServicesAction()).map(
        ({ name, durationMinutes, priceCents, active }) => ({
          name,
          durationMinutes,
          priceCents,
          active,
        }),
      ),
    ).toEqual([
      {
        name: "Pose cil à cil",
        durationMinutes: 120,
        priceCents: 11000,
        active: true,
      },
      {
        name: "Remplissage",
        durationMinutes: 60,
        priceCents: 5500,
        active: true,
      },
      {
        name: "Rehaussement",
        durationMinutes: 75,
        priceCents: 7000,
        active: true,
      },
    ]);
    expect(
      ok(await listBusinessHoursAction()).map(
        ({ weekday, startsAt, endsAt }) => ({
          weekday,
          startsAt,
          endsAt,
        }),
      ),
    ).toEqual(week);
    expect(await getSetupProgress(owner.client, business.id)).toEqual({
      activeServices: 3,
      openingRanges: 11,
    });

    // 4. The agenda offers the active services, in their order; a
    //    deactivated one is no longer bookable, a reordered list follows.
    ok(
      await setServiceActiveAction({
        serviceId: created[1]!.id,
        active: false,
      }),
    );
    ok(
      await reorderServicesAction({
        serviceIds: [created[2]!.id, created[0]!.id, created[1]!.id],
      }),
    );
    expect(
      ok(await listAgendaServicesAction()).services.map(
        (service) => service.name,
      ),
    ).toEqual(["Rehaussement", "Pose cil à cil"]);
    expect(await getSetupProgress(owner.client, business.id)).toMatchObject({
      activeServices: 2,
    });

    // 5. The agenda's opening ranges are those hours, in the business
    //    time zone (not the server's or the browser's).
    const agenda = ok(await getAgendaAction({ startDate: DAY, endDate: DAY }));
    const day = agenda.workingHours.days[0]!;
    expect(day.weekday).toBe(new Date(`${DAY}T12:00:00Z`).getUTCDay());
    // The instants are PostgreSQL's reading of the zone, the calendar
    // authority: Node's tzdata may differ (Node 24 ships 2026c, where
    // British Columbia stays on UTC−7 from November 2026).
    const instant = async (local: string) =>
      (
        await db.query<{ at: Date }>(
          "select ($1::timestamp at time zone $2) as at",
          [local, ZONE],
        )
      ).rows[0]!.at.toISOString();
    const expected = [];
    for (const [start, end] of [
      ["09:00", "12:30"],
      ["13:30", "19:00"],
    ]) {
      expected.push({
        startsAt: await instant(`${DAY}T${start}`),
        endsAt: await instant(`${DAY}T${end}`),
        localStartsAt: `${DAY}T${start}`,
        localEndsAt: `${DAY}T${end}`,
      });
    }
    expect(day.openRanges).toEqual(expected);

    // 6. A manual appointment with a configured service, for a new customer.
    const email = `camille-${randomUUID().slice(0, 8)}@x.test`;
    const appointment = ok(
      await createAppointmentAction({
        date: DAY,
        time: "10:00",
        serviceId: created[2]!.id,
        client: { type: "new", firstName: "Camille", lastName: "Roux", email },
        requestId: randomUUID(),
      }),
    ).appointment;
    expect(appointment.service).toMatchObject({
      id: created[2]!.id,
      name: "Rehaussement",
    });
    expect(
      ok(
        await getAgendaAction({ startDate: DAY, endDate: DAY }),
      ).appointments.map((item) => item.id),
    ).toEqual([appointment.id]);

    // 7. The customer is in the CRM.
    const directory = ok(
      await listClientsAction({
        query: email,
        filter: "all",
        sort: "name",
        limit: 25,
      }),
    );
    expect(directory.clients.map((client) => client.displayName)).toEqual([
      "Camille Roux",
    ]);

    // A deactivated service cannot be booked.
    failure(
      await createAppointmentAction({
        date: DAY,
        time: "14:00",
        serviceId: created[1]!.id,
        client: { type: "existing", clientId: appointment.client.id },
        requestId: randomUUID(),
      }),
      "service_unavailable",
    );
  });
});

describe("another business", () => {
  it("can neither see nor change these services and hours", async () => {
    sessionClient = owner.client;
    const services = ok(await listServicesAction());
    const hours = ok(await listBusinessHoursAction());

    // RLS: counting with another account sees nothing of this business.
    expect(await getSetupProgress(intruder.client, business.id)).toEqual({
      activeServices: 0,
      openingRanges: 0,
    });

    sessionClient = intruder.client;
    failure(
      await updateServiceAction({
        serviceId: services[0]!.id,
        expectedVersion: services[0]!.version,
        changes: { priceCents: 1 },
      }),
      "not_found",
    );
    failure(
      await setServiceActiveAction({
        serviceId: services[0]!.id,
        active: false,
      }),
      "not_found",
    );
    // The business comes from the session: this replaces the intruder's own
    // (empty) schedule, never the owner's.
    ok(await replaceBusinessHoursAction({ hours: [], expected: [] }));

    sessionClient = owner.client;
    expect(ok(await listServicesAction())).toEqual(services);
    expect(ok(await listBusinessHoursAction())).toEqual(hours);
  });

  it("an overlapping week is refused as a whole, keeping the saved one", async () => {
    sessionClient = owner.client;
    const before = ok(await listBusinessHoursAction());
    failure(
      await replaceBusinessHoursAction({
        hours: [
          { weekday: 1, startsAt: "09:00", endsAt: "13:00" },
          { weekday: 1, startsAt: "12:00", endsAt: "18:00" },
        ],
        expected: before,
      }),
      "validation_error",
    );
    expect(ok(await listBusinessHoursAction())).toEqual(before);
  });
});
