import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  cancelAppointmentAction,
  createAppointmentAction,
  createBlockAction,
  deleteBlockAction,
  getAgendaAction,
  getAgendaAppointmentAction,
  getAgendaTodayAction,
  listAgendaServicesAction,
  searchAgendaClientsAction,
  setAppointmentStatusAction,
  updateAppointmentAction,
  updateBlockAction,
} from "@/features/agenda/actions/agenda";
import { createPublicBooking } from "@/features/appointments/data/public-booking";
import type { ActionResult, AppErrorCode } from "@/lib/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { zonedLocalToUtc } from "@/lib/time/zoned";

import {
  anonClient,
  createBusiness,
  createClientRecord,
  createProfessional,
  createService,
  dateInDays,
  db,
  everyDay,
  setWeeklyHours,
  type Professional,
  type TestBusiness,
} from "./support/fixtures";
import {
  closeTransaction,
  openTransaction,
  outcome,
  waitUntilBlocked,
  type OpenTransaction,
} from "./support/transactions";

// Professional agenda V1 against the real stack. The Server Actions are
// called as the UI will call them; only the cookie-based Supabase client is
// replaced by a client signed in as the test professional (or anonymous).

let sessionClient: AppSupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => sessionClient,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const FUTURE = dateInDays(20);
const PAST = dateInDays(-3);

type Agenda = {
  owner: Professional;
  business: TestBusiness;
  service: string;
  shortService: string;
  client: string;
};

async function newAgenda(
  options: { timezone?: string; bufferMinutes?: number } = {},
): Promise<Agenda> {
  const owner = await createProfessional("agenda");
  const business = await createBusiness(owner.userId, {
    timezone: options.timezone ?? "Europe/Paris",
    settings: { buffer_minutes: options.bufferMinutes ?? 15 },
  });
  await setWeeklyHours(business.id, everyDay(["09:00", "19:00"]));
  const service = await createService(business.id, {
    name: "Pose complète",
    durationMinutes: 60,
  });
  const shortService = await createService(business.id, {
    name: "Retouche",
    durationMinutes: 30,
    priceCents: 3000,
  });
  const client = await createClientRecord(
    business.id,
    `julie-${randomUUID().slice(0, 8)}@x.test`,
    "Julie",
  );
  sessionClient = owner.client;

  return { owner, business, service, shortService, client };
}

function as(professional: Professional | null) {
  sessionClient = professional ? professional.client : anonClient();
}

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function failure<T>(result: ActionResult<T>, code: AppErrorCode) {
  expect(result).toMatchObject({ ok: false, error: { code } });
  return result.ok ? undefined : result.error;
}

function utc(agenda: Agenda, date: string, time: string) {
  return zonedLocalToUtc(
    `${date}T${time}`,
    agenda.business.timezone,
  ).toISOString();
}

function create(
  agenda: Agenda,
  time: string,
  overrides: Record<string, unknown> = {},
) {
  return createAppointmentAction({
    date: FUTURE,
    time,
    serviceId: agenda.service,
    client: { type: "existing", clientId: agenda.client },
    ...overrides,
  });
}

async function createOk(
  agenda: Agenda,
  time: string,
  overrides: Record<string, unknown> = {},
) {
  return ok(await create(agenda, time, overrides)).appointment;
}

function block(
  agenda: Agenda,
  startsAt: string,
  endsAt: string,
  date = FUTURE,
) {
  return createBlockAction({
    allDay: false,
    startsAt: `${date}T${startsAt}`,
    endsAt: `${date}T${endsAt}`,
  });
}

async function row(appointmentId: string) {
  const { rows } = await db.query(
    `select status, starts_at, ends_at, service_id, client_id, version,
            duration_minutes_snapshot, buffer_minutes_snapshot,
            service_name_snapshot, internal_notes, cancellation_reason,
            completed_at, created_by
       from public.appointments where id = $1`,
    [appointmentId],
  );
  return rows[0];
}

async function countAppointments(businessId: string) {
  const { rows } = await db.query<{ count: number }>(
    "select count(*)::int as count from public.appointments where business_id = $1",
    [businessId],
  );
  return rows[0]!.count;
}

/** The agenda RPC inside an open transaction, as the signed-in owner. */
function createIn(
  transaction: OpenTransaction,
  agenda: Agenda,
  time: string,
  requestId: string | null = null,
  serviceId: string = agenda.service,
) {
  return transaction.connection.query<{
    appointment_id: string;
    created: boolean;
  }>(
    `select appointment_id, created from public.agenda_create_appointment(
       p_business_id => $1, p_service_id => $2, p_starts_at => $3,
       p_client_id => $4, p_request_id => $5)`,
    [
      agenda.business.id,
      serviceId,
      utc(agenda, FUTURE, time),
      agenda.client,
      requestId,
    ],
  );
}

function asOwner(agenda: Agenda) {
  return openTransaction({
    role: "authenticated",
    userId: agenda.owner.userId,
  });
}

// ---------------------------------------------------------------------------

describe("access control", () => {
  let a: Agenda;
  let b: Agenda;
  let appointmentB: string;

  beforeAll(async () => {
    b = await newAgenda();
    appointmentB = (await createOk(b, "10:00")).id;
    a = await newAgenda();
  });

  it("refuses every action without a session", async () => {
    as(null);

    failure(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
      "unauthenticated",
    );
    failure(await create(a, "10:00"), "unauthenticated");
    failure(await listAgendaServicesAction(), "unauthenticated");
    failure(await getAgendaTodayAction(), "unauthenticated");
    failure(
      await searchAgendaClientsAction({ query: "Julie" }),
      "unauthenticated",
    );
    failure(
      await createBlockAction({
        allDay: true,
        startDate: FUTURE,
        endDate: FUTURE,
      }),
      "unauthenticated",
    );
  });

  it("never lets anonymous callers reach the agenda functions", async () => {
    const { error } = await anonClient().rpc("agenda_create_appointment", {
      p_business_id: a.business.id,
      p_service_id: a.service,
      p_starts_at: utc(a, FUTURE, "10:00"),
      p_client_id: a.client,
    });

    expect(error?.code).toBe("42501");
    expect(await countAppointments(a.business.id)).toBe(0);
  });

  it("shows tenant A nothing of tenant B's agenda", async () => {
    as(a.owner);

    const agenda = ok(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
    );
    expect(agenda.appointments).toEqual([]);
    failure(
      await getAgendaAppointmentAction({ appointmentId: appointmentB }),
      "appointment_not_found",
    );

    // Even straight through PostgREST with A's session.
    const direct = await a.owner.client
      .from("appointments")
      .select("id")
      .eq("id", appointmentB);
    expect(direct.data).toEqual([]);
  });

  it("ignores any business identifier sent by the browser", async () => {
    as(a.owner);

    const created = await createOk(a, "12:00", {
      businessId: b.business.id,
      business_id: b.business.id,
    });

    expect(await countAppointments(b.business.id)).toBe(1);
    const { rows } = await db.query(
      "select business_id from public.appointments where id = $1",
      [created.id],
    );
    expect(rows[0].business_id).toBe(a.business.id);
  });

  it("refuses B's resources inside A's business", async () => {
    as(a.owner);

    failure(
      await create(a, "14:00", { serviceId: b.service }),
      "service_unavailable",
    );
    failure(
      await create(a, "14:00", {
        client: { type: "existing", clientId: b.client },
      }),
      "client_not_found",
    );
    failure(
      await updateAppointmentAction({
        appointmentId: appointmentB,
        expectedVersion: 1,
        date: FUTURE,
        time: "15:00",
        serviceId: a.service,
        clientId: a.client,
      }),
      "appointment_not_found",
    );
    failure(
      await cancelAppointmentAction({
        appointmentId: appointmentB,
        expectedVersion: 1,
      }),
      "appointment_not_found",
    );
    expect((await row(appointmentB)).status).toBe("confirmed");
  });

  it("refuses A's session on B's business at the database level", async () => {
    const { error } = await a.owner.client.rpc(
      "agenda_set_appointment_status",
      {
        p_business_id: b.business.id,
        p_appointment_id: appointmentB,
        p_expected_version: 1,
        p_status: "cancelled",
      },
    );
    expect(error?.message).toBe("forbidden");

    const search = await a.owner.client.rpc("search_clients", {
      p_business_id: b.business.id,
      p_query: "Julie",
    });
    expect(search.data).toEqual([]);
    expect((await row(appointmentB)).status).toBe("confirmed");
  });

  it("closes the agenda as soon as the membership is removed", async () => {
    const c = await newAgenda();
    const appointment = await createOk(c, "10:00");
    await db.query(
      "delete from public.business_members where business_id = $1",
      [c.business.id],
    );

    failure(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
      "no_business",
    );
    failure(await create(c, "12:00"), "no_business");

    // The same session calling the database directly is refused too.
    const { error } = await c.owner.client.rpc("agenda_update_appointment", {
      p_business_id: c.business.id,
      p_appointment_id: appointment.id,
      p_expected_version: appointment.version,
      p_starts_at: utc(c, FUTURE, "15:00"),
      p_service_id: c.service,
      p_client_id: c.client,
    });
    expect(error?.message).toBe("forbidden");
    expect((await row(appointment.id)).starts_at.toISOString()).toBe(
      appointment.startsAt,
    );
  });
});

// ---------------------------------------------------------------------------

describe("reading a range", () => {
  let a: Agenda;

  beforeAll(async () => {
    a = await newAgenda();
  });

  it("refuses inverted, empty-shaped and oversized ranges", async () => {
    as(a.owner);

    failure(
      await getAgendaAction({
        startDate: dateInDays(5),
        endDate: dateInDays(4),
      }),
      "validation_error",
    );
    failure(
      await getAgendaAction({ startDate: "2026-02-30", endDate: FUTURE }),
      "validation_error",
    );
    failure(
      await getAgendaAction({
        startDate: dateInDays(0),
        endDate: dateInDays(42),
      }),
      "validation_error",
    );
    expect(
      ok(
        await getAgendaAction({
          startDate: dateInDays(0),
          endDate: dateInDays(41),
        }),
      ).workingHours.days,
    ).toHaveLength(42);
  });

  it("returns appointments, blocks and opening hours with minimal fields", async () => {
    as(a.owner);
    const kept = await createOk(a, "10:00", {
      internalNotes: "Allergie colle",
    });
    const cancelled = await createOk(a, "15:00");
    ok(
      await cancelAppointmentAction({
        appointmentId: cancelled.id,
        expectedVersion: cancelled.version,
      }),
    );
    ok(await block(a, "12:00", "13:00"));
    await db.query(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
       values ($1, 'open_override', $2, $3)`,
      [a.business.id, utc(a, FUTURE, "19:00"), utc(a, FUTURE, "21:00")],
    );

    const agenda = ok(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
    );

    expect(agenda.timezone).toBe("Europe/Paris");
    expect(agenda.appointments).toEqual([
      {
        id: kept.id,
        version: 1,
        status: "confirmed",
        startsAt: utc(a, FUTURE, "10:00"),
        endsAt: utc(a, FUTURE, "11:00"),
        localStartsAt: `${FUTURE}T10:00`,
        localEndsAt: `${FUTURE}T11:00`,
        durationMinutes: 60,
        startOccurrence: null,
        bufferMinutes: 15,
        priceCents: 6500,
        currency: "EUR",
        service: { id: a.service, name: "Pose complète" },
        client: { id: a.client, displayName: "Julie" },
        internalNotes: "Allergie colle",
        cancellationReason: null,
        source: "manual",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(agenda.blocks).toMatchObject([
      {
        kind: "blocked",
        localStartsAt: `${FUTURE}T12:00`,
        localEndsAt: `${FUTURE}T13:00`,
        version: 1,
      },
    ]);
    expect(agenda.workingHours.days).toEqual([
      {
        date: FUTURE,
        weekday: new Date(`${FUTURE}T00:00Z`).getUTCDay(),
        startsAt: utc(a, FUTURE, "00:00"),
        endsAt: new Date(
          Date.parse(utc(a, FUTURE, "00:00")) + 24 * 3_600_000,
        ).toISOString(),
        openRanges: [
          // Weekly 09:00–19:00 + exceptional opening 19:00–21:00: one real
          // opening, merged exactly as public availability merges it
          // (private.opening_ranges).
          expect.objectContaining({
            startsAt: utc(a, FUTURE, "09:00"),
            endsAt: utc(a, FUTURE, "21:00"),
            localStartsAt: `${FUTURE}T09:00`,
            localEndsAt: `${FUTURE}T21:00`,
          }),
        ],
      },
    ]);
    expect(agenda.workingHours.weekly).toHaveLength(7);

    const withCancelled = ok(
      await getAgendaAction({
        startDate: FUTURE,
        endDate: FUTURE,
        includeCancelled: true,
      }),
    );
    expect(withCancelled.appointments.map((item) => item.status)).toEqual([
      "confirmed",
      "cancelled",
    ]);
  });

  it("lists public bookings and manual appointments from the same table", async () => {
    const p = await newAgenda();
    await db.query(
      "update public.business_settings set minimum_booking_notice_minutes = 0 where business_id = $1",
      [p.business.id],
    );
    const publicBooking = await createPublicBooking(anonClient(), {
      slug: p.business.slug,
      serviceId: p.service,
      startsAt: utc(p, FUTURE, "09:00"),
      firstName: "Léa",
      email: "lea@x.test",
    });
    await createOk(p, "14:00");

    const agenda = ok(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
    );
    expect(
      agenda.appointments.map((item) => [
        item.id === publicBooking.appointmentId,
        item.source,
      ]),
    ).toEqual([
      [true, "public"],
      [false, "manual"],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("time zone", () => {
  it("works in the business zone across the autumn DST change", async () => {
    const a = await newAgenda({ timezone: "Europe/Paris", bufferMinutes: 0 });
    // 2026-10-25 lasts 25 hours in Paris (CEST → CET at 03:00).
    const day = "2026-10-25";

    const created = await createOk(a, "10:00", { date: day });
    expect(created.startsAt).toBe("2026-10-25T09:00:00.000Z");
    expect(created.localStartsAt).toBe(`${day}T10:00`);

    // 23:30–00:00: ends exactly at the next local midnight.
    const late = await createOk(a, "23:30", {
      date: day,
      serviceId: a.shortService,
    });
    const agenda = ok(await getAgendaAction({ startDate: day, endDate: day }));

    expect(agenda.range).toEqual({
      startDate: day,
      endDate: day,
      startsAt: "2026-10-24T22:00:00.000Z",
      endsAt: "2026-10-25T23:00:00.000Z",
    });
    expect(agenda.appointments.map((item) => item.id)).toEqual([
      created.id,
      late.id,
    ]);
    expect(agenda.workingHours.days[0]!.openRanges[0]).toEqual({
      startsAt: "2026-10-25T08:00:00.000Z",
      endsAt: "2026-10-25T18:00:00.000Z",
      localStartsAt: `${day}T09:00`,
      localEndsAt: `${day}T19:00`,
    });

    // Half-open days: the next local day does not contain it.
    const next = ok(
      await getAgendaAction({ startDate: "2026-10-26", endDate: "2026-10-26" }),
    );
    expect(next.appointments).toEqual([]);
  });

  it("refuses a start time skipped by the spring DST change", async () => {
    const a = await newAgenda({ timezone: "Europe/Paris" });

    const error = failure(
      await create(a, "02:30", { date: "2027-03-28" }),
      "validation_error",
    );
    expect(error?.fieldErrors).toHaveProperty("time");
    await createOk(a, "03:00", { date: "2027-03-28" });
  });

  it("never assumes Europe/Paris", async () => {
    const a = await newAgenda({ timezone: "America/New_York" });

    const created = await createOk(a, "10:00");
    expect(created.startsAt).toBe(
      zonedLocalToUtc(`${FUTURE}T10:00`, "America/New_York").toISOString(),
    );
    expect(created.localStartsAt).toBe(`${FUTURE}T10:00`);
  });
});

// ---------------------------------------------------------------------------

describe("manual creation", () => {
  it("books an existing client with server-side duration, buffer and end", async () => {
    const a = await newAgenda({ bufferMinutes: 15 });

    const { appointment, created } = ok(
      await create(a, "10:00", {
        // Never trusted: the server derives all of these.
        durationMinutes: 5,
        endsAt: `${FUTURE}T10:05`,
        bufferMinutes: 0,
      }),
    );

    expect(created).toBe(true);
    expect(appointment).toMatchObject({
      status: "confirmed",
      localStartsAt: `${FUTURE}T10:00`,
      localEndsAt: `${FUTURE}T11:00`,
      durationMinutes: 60,
      bufferMinutes: 15,
      client: { id: a.client, displayName: "Julie" },
      source: "manual",
    });
    expect(await row(appointment.id)).toMatchObject({
      created_by: a.owner.userId,
      service_name_snapshot: "Pose complète",
    });
  });

  it("creates a new client from minimal information", async () => {
    const a = await newAgenda();

    const { appointment } = ok(
      await create(a, "10:00", {
        client: {
          type: "new",
          firstName: " Inès ",
          lastName: "Morel",
          phone: "06 12 34 56 78",
        },
      }),
    );

    expect(appointment.client.displayName).toBe("Inès Morel");
    const { rows } = await db.query(
      "select business_id, first_name, last_name, email, phone from public.clients where id = $1",
      [appointment.client.id],
    );
    expect(rows[0]).toEqual({
      business_id: a.business.id,
      first_name: "Inès",
      last_name: "Morel",
      email: null,
      phone: "06 12 34 56 78",
    });
  });

  it("reuses the client of this business with the same email, unchanged", async () => {
    const a = await newAgenda();
    const email = (
      await db.query("select email from public.clients where id = $1", [
        a.client,
      ])
    ).rows[0].email as string;

    const { appointment } = ok(
      await create(a, "10:00", {
        client: { type: "new", firstName: "Autre", email: email.toUpperCase() },
      }),
    );

    expect(appointment.client).toEqual({ id: a.client, displayName: "Julie" });

    // Same email in another business: a separate client there.
    const b = await newAgenda();
    const other = ok(
      await create(b, "10:00", {
        client: { type: "new", firstName: "Julie", email },
      }),
    );
    expect(other.appointment.client.id).not.toBe(a.client);
  });

  it("refuses an inactive or unknown service", async () => {
    const a = await newAgenda();
    await db.query("update public.services set active = false where id = $1", [
      a.shortService,
    ]);

    failure(
      await create(a, "10:00", { serviceId: a.shortService }),
      "service_unavailable",
    );
    failure(
      await create(a, "10:00", { serviceId: randomUUID() }),
      "service_unavailable",
    );
    failure(
      await create(a, "10:00", {
        client: { type: "existing", clientId: randomUUID() },
      }),
      "client_not_found",
    );
    expect(await countAppointments(a.business.id)).toBe(0);
  });

  it("allows times outside opening hours but never an overlap", async () => {
    const a = await newAgenda({ bufferMinutes: 15 });

    await createOk(a, "20:00");
    await createOk(a, "10:00");

    // Overlap, and a start inside the 15-minute buffer of 10:00–11:00.
    failure(await create(a, "10:30"), "schedule_conflict");
    failure(await create(a, "11:10"), "schedule_conflict");
    // Its own buffer would reach the next appointment: 11:20 + 30 + 15 > 12:00.
    await createOk(a, "12:00", { serviceId: a.shortService });
    failure(
      await create(a, "11:20", { serviceId: a.shortService }),
      "schedule_conflict",
    );
    // Exactly between the two buffers.
    await createOk(a, "11:15", { serviceId: a.shortService });
    expect(await countAppointments(a.business.id)).toBe(4);
  });

  it("refuses an appointment inside a block, and a block over an appointment", async () => {
    const a = await newAgenda();

    ok(await block(a, "12:00", "14:00"));
    failure(await create(a, "13:00"), "schedule_conflict");
    failure(await create(a, "11:30"), "schedule_conflict");
    await createOk(a, "11:00", { serviceId: a.shortService, time: "11:30" });

    await createOk(a, "16:00");
    failure(await block(a, "16:30", "17:30"), "schedule_conflict");
    failure(
      await createBlockAction({
        allDay: true,
        startDate: FUTURE,
        endDate: FUTURE,
      }),
      "schedule_conflict",
    );
  });

  it("creates one appointment from a double submit (same request id)", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();

    const first = ok(await create(a, "10:00", { requestId }));
    const second = ok(await create(a, "10:00", { requestId }));

    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      created: false,
      appointment: { id: first.appointment.id },
    });

    // Simultaneous double click.
    const other = randomUUID();
    const results = await Promise.all([
      create(a, "14:00", { requestId: other }),
      create(a, "14:00", { requestId: other }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await countAppointments(a.business.id)).toBe(2);
  });

  it("without request id, a repeated submit is refused by the overlap", async () => {
    const a = await newAgenda();

    await createOk(a, "10:00");
    failure(await create(a, "10:00"), "schedule_conflict");
    expect(await countAppointments(a.business.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("concurrency (PostgreSQL)", () => {
  it("serialises two creations of the same slot: the second waits, then conflicts", async () => {
    const a = await newAgenda();
    const first = await asOwner(a);
    const second = await asOwner(a);

    await createIn(first, a, "10:00");
    const result = outcome(createIn(second, a, "10:30"));
    await waitUntilBlocked(second.pid);

    await closeTransaction(first, "commit");
    expect(await result).toBe("schedule_conflict");
    await closeTransaction(second, "rollback");
    expect(await countAppointments(a.business.id)).toBe(1);
  });

  it("gives a slot to exactly one of many simultaneous actions", async () => {
    const a = await newAgenda();

    const results = await Promise.all(
      Array.from({ length: 6 }, () => create(a, "10:00")),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.ok && result.error.code === "schedule_conflict",
      ),
    ).toHaveLength(5);
  });

  it("appointment first: a concurrent block waits, then is refused", async () => {
    const a = await newAgenda();
    const creating = await asOwner(a);
    const blocking = await asOwner(a);

    await createIn(creating, a, "10:00");
    const result = outcome(
      blocking.connection.query(
        `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
         values ($1, 'blocked', $2, $3)`,
        [a.business.id, utc(a, FUTURE, "10:30"), utc(a, FUTURE, "11:30")],
      ),
    );
    await waitUntilBlocked(blocking.pid);

    await closeTransaction(creating, "commit");
    expect(await result).toBe("schedule_conflict");
    await closeTransaction(blocking, "rollback");
  });

  it("block first: a concurrent creation waits, then is refused", async () => {
    const a = await newAgenda();
    const blocking = await asOwner(a);
    const creating = await asOwner(a);

    await blocking.connection.query(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
       values ($1, 'blocked', $2, $3)`,
      [a.business.id, utc(a, FUTURE, "10:30"), utc(a, FUTURE, "11:30")],
    );
    const result = outcome(createIn(creating, a, "10:00"));
    await waitUntilBlocked(creating.pid);

    await closeTransaction(blocking, "commit");
    expect(await result).toBe("schedule_conflict");
    await closeTransaction(creating, "rollback");
    expect(await countAppointments(a.business.id)).toBe(0);
  });

  it("serialises a public booking and a manual creation of the same slot", async () => {
    const a = await newAgenda();
    await db.query(
      "update public.business_settings set minimum_booking_notice_minutes = 0 where business_id = $1",
      [a.business.id],
    );
    const booking = await openTransaction({ role: "anon" });
    const creating = await asOwner(a);

    await booking.connection.query(
      `select appointment_id from public.create_public_booking(
         p_slug => $1, p_service_id => $2, p_starts_at => $3,
         p_first_name => 'Léa', p_email => 'lea@x.test')`,
      [a.business.slug, a.service, utc(a, FUTURE, "10:00")],
    );
    const result = outcome(createIn(creating, a, "10:00"));
    await waitUntilBlocked(creating.pid);

    await closeTransaction(booking, "commit");
    expect(await result).toBe("schedule_conflict");
    await closeTransaction(creating, "rollback");
    expect(await countAppointments(a.business.id)).toBe(1);
  });

  it("two edits from the same stale version: the second gets stale_appointment", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");
    const edit = (transaction: OpenTransaction, time: string) =>
      transaction.connection.query(
        `select public.agenda_update_appointment(
           p_business_id => $1, p_appointment_id => $2, p_expected_version => $3,
           p_starts_at => $4, p_service_id => $5, p_client_id => $6)`,
        [
          a.business.id,
          appointment.id,
          appointment.version,
          utc(a, FUTURE, time),
          a.service,
          a.client,
        ],
      );
    const first = await asOwner(a);
    const second = await asOwner(a);

    await edit(first, "14:00");
    const result = outcome(edit(second, "16:00"));
    await waitUntilBlocked(second.pid);

    await closeTransaction(first, "commit");
    expect(await result).toBe("stale_appointment");
    await closeTransaction(second, "rollback");
    expect((await row(appointment.id)).starts_at.toISOString()).toBe(
      utc(a, FUTURE, "14:00"),
    );
  });

  it("refuses isolation levels the schedule lock cannot protect", async () => {
    const a = await newAgenda();
    const transaction = await openTransaction({
      role: "authenticated",
      userId: a.owner.userId,
      isolation: "repeatable read",
    });

    expect(await outcome(createIn(transaction, a, "10:00"))).toBe(
      "unsupported_isolation_level",
    );
    await closeTransaction(transaction, "rollback");
  });
});

// ---------------------------------------------------------------------------

describe("editing and rescheduling", () => {
  function edit(
    agenda: Agenda,
    appointment: { id: string; version: number },
    overrides: Record<string, unknown> = {},
  ) {
    return updateAppointmentAction({
      appointmentId: appointment.id,
      expectedVersion: appointment.version,
      date: FUTURE,
      time: "10:00",
      serviceId: agenda.service,
      clientId: agenda.client,
      internalNotes: null,
      ...overrides,
    });
  }

  it("moves an appointment to a free time", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");

    const moved = ok(
      await edit(a, appointment, { time: "15:30", date: dateInDays(21) }),
    );

    expect(moved).toMatchObject({
      id: appointment.id,
      version: appointment.version + 1,
      localStartsAt: `${dateInDays(21)}T15:30`,
      localEndsAt: `${dateInDays(21)}T16:30`,
    });
    // The old time is free again.
    await createOk(a, "10:00");
  });

  it("refuses a move onto another appointment or a block, keeping the row", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");
    await createOk(a, "14:00");
    ok(await block(a, "17:00", "18:00"));

    failure(await edit(a, appointment, { time: "14:30" }), "schedule_conflict");
    failure(await edit(a, appointment, { time: "13:30" }), "schedule_conflict");
    failure(await edit(a, appointment, { time: "16:30" }), "schedule_conflict");
    expect(await row(appointment.id)).toMatchObject({
      version: 1,
      starts_at: new Date(utc(a, FUTURE, "10:00")),
    });
  });

  it("recomputes duration, name, price and buffer when the service changes", async () => {
    const a = await newAgenda({ bufferMinutes: 10 });
    const appointment = await createOk(a, "10:00", {
      serviceId: a.shortService,
    });
    await db.query(
      "update public.business_settings set buffer_minutes = 20 where business_id = $1",
      [a.business.id],
    );

    const changed = ok(await edit(a, appointment, { serviceId: a.service }));

    expect(changed).toMatchObject({
      localEndsAt: `${FUTURE}T11:00`,
      durationMinutes: 60,
      bufferMinutes: 20,
      service: { id: a.service, name: "Pose complète" },
    });
    expect(await row(appointment.id)).toMatchObject({
      duration_minutes_snapshot: 60,
    });
  });

  it("refuses a longer service that no longer fits before the next appointment", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const appointment = await createOk(a, "10:00", {
      serviceId: a.shortService,
    });
    await createOk(a, "10:45", { serviceId: a.shortService });

    failure(
      await edit(a, appointment, { serviceId: a.service }),
      "schedule_conflict",
    );
    expect(await row(appointment.id)).toMatchObject({
      duration_minutes_snapshot: 30,
    });
  });

  it("keeps the booked duration when the service itself is unchanged", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");
    await db.query(
      "update public.services set duration_minutes = 120 where id = $1",
      [a.service],
    );

    const moved = ok(await edit(a, appointment, { time: "14:00" }));
    expect(moved).toMatchObject({
      durationMinutes: 60,
      localEndsAt: `${FUTURE}T15:00`,
    });
  });

  it("refuses an inactive new service, and a client of another business", async () => {
    const a = await newAgenda();
    const b = await newAgenda();
    sessionClient = a.owner.client;
    const appointment = await createOk(a, "10:00");
    await db.query("update public.services set active = false where id = $1", [
      a.shortService,
    ]);

    failure(
      await edit(a, appointment, { serviceId: a.shortService }),
      "service_unavailable",
    );
    failure(
      await edit(a, appointment, { clientId: b.client }),
      "client_not_found",
    );

    const other = await createClientRecord(
      a.business.id,
      `other-${randomUUID()}@x.test`,
      "Nora",
    );
    expect(ok(await edit(a, appointment, { clientId: other })).client).toEqual({
      id: other,
      displayName: "Nora",
    });
  });

  it("refuses an edit based on a stale version", async () => {
    const a = await newAgenda();
    const loaded = await createOk(a, "10:00");
    // Changed elsewhere after the form was opened.
    ok(await edit(a, loaded, { internalNotes: "Changée ailleurs" }));

    failure(await edit(a, loaded, { time: "15:00" }), "stale_appointment");
    expect(await row(loaded.id)).toMatchObject({
      version: 2,
      internal_notes: "Changée ailleurs",
      starts_at: new Date(utc(a, FUTURE, "10:00")),
    });
  });

  it("only edits notes once an appointment is no longer confirmed", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00", { date: PAST });
    const done = ok(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        status: "completed",
      }),
    );

    failure(
      await edit(a, done, { date: PAST, time: "15:00" }),
      "appointment_not_editable",
    );
    expect(
      ok(await edit(a, done, { date: PAST, internalNotes: "Très contente" }))
        .internalNotes,
    ).toBe("Très contente");
  });
});

// ---------------------------------------------------------------------------

describe("status", () => {
  it("cancels without deleting and frees the slot", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");

    const cancelled = ok(
      await cancelAppointmentAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        reason: "Malade",
      }),
    );

    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellationReason: "Malade",
    });
    expect(await countAppointments(a.business.id)).toBe(1);
    // appointments_no_overlap ignores cancelled rows: the slot is bookable.
    await createOk(a, "10:00");
    // Terminal: a cancelled appointment cannot come back.
    failure(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: cancelled.version,
        status: "confirmed",
      }),
      "invalid_status_transition",
    );
  });

  it("treats a repeated status change as a success (double submit)", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");
    const input = {
      appointmentId: appointment.id,
      expectedVersion: appointment.version,
    };

    const [first, second] = await Promise.all([
      cancelAppointmentAction(input),
      cancelAppointmentAction(input),
    ]);

    expect(ok(first).status).toBe("cancelled");
    expect(ok(second).status).toBe("cancelled");
    expect((await row(appointment.id)).version).toBe(2);
  });

  it("completes a past appointment, which keeps its slot", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00", { date: PAST });

    const completed = ok(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        status: "completed",
      }),
    );

    expect(completed.status).toBe("completed");
    expect((await row(appointment.id)).completed_at).not.toBeNull();
    failure(await create(a, "10:30", { date: PAST }), "schedule_conflict");
  });

  it("marks a past appointment as no-show, still occupying, and allows corrections", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00", { date: PAST });

    const noShow = ok(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        status: "no_show",
      }),
    );
    expect(noShow.status).toBe("no_show");
    failure(await create(a, "10:00", { date: PAST }), "schedule_conflict");

    const back = ok(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: noShow.version,
        status: "confirmed",
      }),
    );
    const completed = ok(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: back.version,
        status: "completed",
      }),
    );
    failure(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: completed.version,
        status: "no_show",
      }),
      "invalid_status_transition",
    );
  });

  it("refuses completed or no-show before the appointment has started", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");

    for (const status of ["completed", "no_show"] as const) {
      failure(
        await setAppointmentStatusAction({
          appointmentId: appointment.id,
          expectedVersion: appointment.version,
          status,
        }),
        "invalid_status_transition",
      );
    }
    expect((await row(appointment.id)).status).toBe("confirmed");
  });

  it("refuses a status change based on a stale version", async () => {
    const a = await newAgenda();
    const loaded = await createOk(a, "10:00");
    ok(
      await updateAppointmentAction({
        appointmentId: loaded.id,
        expectedVersion: loaded.version,
        date: FUTURE,
        time: "11:00",
        serviceId: a.service,
        clientId: a.client,
      }),
    );

    failure(
      await cancelAppointmentAction({
        appointmentId: loaded.id,
        expectedVersion: loaded.version,
      }),
      "stale_appointment",
    );
    expect((await row(loaded.id)).status).toBe("confirmed");
  });

  it("does not reopen a completed appointment once loyalty points were granted", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00", { date: PAST });
    const completed = ok(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        status: "completed",
      }),
    );
    await db.query(
      `insert into public.loyalty_events
         (business_id, client_id, appointment_id, type, points_delta, reason, idempotency_key)
       values ($1, $2, $3, 'appointment_completed', 1, 'Rendez-vous', $4)`,
      [a.business.id, a.client, appointment.id, `completed:${appointment.id}`],
    );

    failure(
      await setAppointmentStatusAction({
        appointmentId: appointment.id,
        expectedVersion: completed.version,
        status: "confirmed",
      }),
      "invalid_status_transition",
    );
  });

  it("keeps a direct write to appointments impossible for professionals", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");

    await a.owner.client
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointment.id);
    await a.owner.client.from("appointments").delete().eq("id", appointment.id);

    expect((await row(appointment.id)).status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------

describe("blocks", () => {
  it("blocks a period or whole days, in the business zone", async () => {
    const a = await newAgenda();

    const period = ok(await block(a, "12:00", "14:00"));
    expect(period).toMatchObject({
      kind: "blocked",
      version: 1,
      startsAt: utc(a, FUTURE, "12:00"),
      endsAt: utc(a, FUTURE, "14:00"),
    });

    // A whole day on the 25-hour autumn day.
    const day = ok(
      await createBlockAction({
        allDay: true,
        startDate: "2026-10-25",
        endDate: "2026-10-25",
        reason: "Formation",
      }),
    );
    expect(day).toMatchObject({
      startsAt: "2026-10-24T22:00:00.000Z",
      endsAt: "2026-10-25T23:00:00.000Z",
      localStartsAt: "2026-10-25T00:00",
      localEndsAt: "2026-10-26T00:00",
      reason: "Formation",
    });
  });

  it("moves and deletes a block with its current version only", async () => {
    const a = await newAgenda();
    const loaded = ok(await block(a, "12:00", "13:00"));

    const moved = ok(
      await updateBlockAction({
        blockId: loaded.id,
        expectedVersion: loaded.version,
        block: {
          allDay: false,
          startsAt: `${FUTURE}T15:00`,
          endsAt: `${FUTURE}T16:00`,
        },
      }),
    );
    expect(moved).toMatchObject({
      version: 2,
      localStartsAt: `${FUTURE}T15:00`,
    });

    failure(
      await updateBlockAction({
        blockId: loaded.id,
        expectedVersion: loaded.version,
        block: {
          allDay: false,
          startsAt: `${FUTURE}T17:00`,
          endsAt: `${FUTURE}T18:00`,
        },
      }),
      "stale_block",
    );
    failure(
      await deleteBlockAction({
        blockId: loaded.id,
        expectedVersion: loaded.version,
      }),
      "stale_block",
    );

    ok(
      await deleteBlockAction({
        blockId: loaded.id,
        expectedVersion: moved.version,
      }),
    );
    failure(
      await deleteBlockAction({
        blockId: loaded.id,
        expectedVersion: moved.version,
      }),
      "block_not_found",
    );
  });

  it("never moves a block over an appointment", async () => {
    const a = await newAgenda();
    await createOk(a, "10:00");
    const loaded = ok(await block(a, "15:00", "16:00"));

    failure(
      await updateBlockAction({
        blockId: loaded.id,
        expectedVersion: loaded.version,
        block: {
          allDay: false,
          startsAt: `${FUTURE}T10:30`,
          endsAt: `${FUTURE}T11:30`,
        },
      }),
      "schedule_conflict",
    );
    const { rows } = await db.query(
      "select starts_at, version from public.availability_exceptions where id = $1",
      [loaded.id],
    );
    expect(rows[0]).toEqual({
      starts_at: new Date(utc(a, FUTURE, "15:00")),
      version: 1,
    });
  });

  it("cannot touch the blocks of another business or exceptional openings", async () => {
    const a = await newAgenda();
    const foreign = ok(await block(a, "12:00", "13:00"));
    const { rows } = await db.query<{ id: string }>(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
       values ($1, 'open_override', $2, $3) returning id`,
      [a.business.id, utc(a, FUTURE, "19:00"), utc(a, FUTURE, "21:00")],
    );

    failure(
      await deleteBlockAction({ blockId: rows[0]!.id, expectedVersion: 1 }),
      "block_not_found",
    );

    const b = await newAgenda();
    sessionClient = b.owner.client;
    failure(
      await deleteBlockAction({ blockId: foreign.id, expectedVersion: 1 }),
      "block_not_found",
    );
    failure(
      await updateBlockAction({
        blockId: foreign.id,
        expectedVersion: 1,
        block: { allDay: true, startDate: FUTURE, endDate: FUTURE },
      }),
      "block_not_found",
    );
  });
});

// ---------------------------------------------------------------------------

describe("today", () => {
  // What the agenda asks before any action that depends on today, instead
  // of trusting a clock of its own. Everything comes from PostgreSQL, in
  // one call: the date, the instant it ends and the database's own "now".
  it("date, end and now are PostgreSQL's, coherent with each other, in the business time zone", async () => {
    const databaseNow = async () =>
      (await db.query<{ now: Date }>("select now() as now")).rows[0]!.now;

    // 25 hours apart: these two businesses never share a date, wherever the
    // test machine is.
    const dates: string[] = [];
    for (const timezone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      await newAgenda({ timezone });
      const before = await databaseNow();
      const today = ok(await getAgendaTodayAction());
      const after = await databaseNow();

      expect(Object.keys(today).sort()).toEqual(["date", "endsAt", "now"]);
      // `now` is the database's clock, between two readings of that clock.
      expect(Date.parse(today.now)).toBeGreaterThanOrEqual(before.getTime());
      expect(Date.parse(today.now)).toBeLessThanOrEqual(after.getTime());

      // The date and its end are exactly what PostgreSQL computes for that
      // very instant: one snapshot, no mix of clocks.
      const { rows } = await db.query<{ date: string; ends_at: Date }>(
        `select private.local_date_of($1::timestamptz, $2)::text as date,
                private.local_day_start(
                  private.local_date_of($1::timestamptz, $2) + 1, $2
                ) as ends_at`,
        [today.now, timezone],
      );
      expect(today.date).toBe(rows[0]!.date);
      expect(today.endsAt).toBe(rows[0]!.ends_at.toISOString());

      // Never "today = D" with now already at or past the end of D.
      const remaining = Date.parse(today.endsAt) - Date.parse(today.now);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(24 * 3_600_000);
      dates.push(today.date);
    }
    expect(dates[0]! > dates[1]!).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("form lookups", () => {
  it("lists active services with the buffer that will apply", async () => {
    const a = await newAgenda({ bufferMinutes: 15 });
    await db.query("update public.services set active = false where id = $1", [
      a.shortService,
    ]);

    expect(ok(await listAgendaServicesAction())).toEqual({
      services: [
        {
          id: a.service,
          name: "Pose complète",
          durationMinutes: 60,
          priceCents: 6500,
        },
      ],
      bufferMinutes: 15,
      currency: "EUR",
    });
  });

  it("searches clients of this business only, wildcards included", async () => {
    const a = await newAgenda();
    const b = await newAgenda();
    await createClientRecord(b.business.id, "julie.b@x.test", "Julie");
    await db.query(
      "update public.clients set phone = '06 11 22 33 44' where id = $1",
      [a.client],
    );
    sessionClient = a.owner.client;

    expect(ok(await searchAgendaClientsAction({ query: "jul" }))).toEqual([
      {
        id: a.client,
        displayName: "Julie",
        email: expect.any(String),
        phone: "06 11 22 33 44",
      },
    ]);
    expect(
      ok(await searchAgendaClientsAction({ query: "22 33" })),
    ).toHaveLength(1);
    // LIKE wildcards are literal characters, not "match everything".
    expect(ok(await searchAgendaClientsAction({ query: "%%" }))).toEqual([]);
    expect(ok(await searchAgendaClientsAction({ query: "__" }))).toEqual([]);
    failure(
      await searchAgendaClientsAction({ query: "j" }),
      "validation_error",
    );
  });
});

// ---------------------------------------------------------------------------

describe("idempotency key", () => {
  async function clientsWithEmail(businessId: string, email: string) {
    const { rows } = await db.query<{ count: number }>(
      "select count(*)::int as count from public.clients where business_id = $1 and email = $2",
      [businessId, email],
    );
    return rows[0]!.count;
  }

  it("returns the first result to a sequential retry of the same command", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();
    const email = `new-${randomUUID().slice(0, 8)}@x.test`;
    const payload = {
      requestId,
      internalNotes: "Première fois",
      client: { type: "new", firstName: "Nina", email },
    };

    const first = ok(await create(a, "10:00", payload));
    const retry = ok(await create(a, "10:00", payload));

    expect(first.created).toBe(true);
    expect(retry).toEqual({ created: false, appointment: first.appointment });
    expect(await countAppointments(a.business.id)).toBe(1);
    expect(await clientsWithEmail(a.business.id, email)).toBe(1);
  });

  it("refuses the same key for another command, creating nothing", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();
    const other = await createClientRecord(
      a.business.id,
      `b-${randomUUID()}@x.test`,
      "Bea",
    );
    const first = ok(await create(a, "10:00", { requestId }));
    const email = `ghost-${randomUUID().slice(0, 8)}@x.test`;

    for (const changed of [
      { time: "14:00" },
      { date: dateInDays(21) },
      { serviceId: a.shortService },
      { client: { type: "existing", clientId: other } },
      { client: { type: "new", firstName: "Ghost", email } },
      { internalNotes: "Autre note" },
    ]) {
      const error = failure(
        await create(a, "10:00", { requestId, ...changed }),
        "idempotency_conflict",
      );
      expect(error?.fieldErrors).toHaveProperty("requestId");
    }

    expect(await countAppointments(a.business.id)).toBe(1);
    expect((await row(first.appointment.id)).starts_at.toISOString()).toBe(
      first.appointment.startsAt,
    );
    // No partial data: the refused commands created no client either.
    expect(await clientsWithEmail(a.business.id, email)).toBe(0);
  });

  it("concurrent retries of the same command: one creation, same answer", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();
    const first = await asOwner(a);
    const second = await asOwner(a);

    const created = await createIn(first, a, "10:00", requestId);
    const replay = createIn(second, a, "10:00", requestId);
    await waitUntilBlocked(second.pid);

    await closeTransaction(first, "commit");
    const { rows } = await replay;
    await closeTransaction(second, "commit");

    expect(rows[0]).toEqual({
      appointment_id: created.rows[0]!.appointment_id,
      created: false,
    });
    expect(await countAppointments(a.business.id)).toBe(1);
  });

  it("concurrent commands with the same key: one wins, the other conflicts", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();
    const first = await asOwner(a);
    const second = await asOwner(a);

    await createIn(first, a, "10:00", requestId);
    const other = outcome(
      createIn(second, a, "14:00", requestId, a.shortService),
    );
    await waitUntilBlocked(second.pid);

    await closeTransaction(first, "commit");
    expect(await other).toBe("idempotency_conflict");
    await closeTransaction(second, "rollback");

    const { rows } = await db.query(
      "select starts_at, service_id from public.appointments where business_id = $1",
      [a.business.id],
    );
    expect(rows).toEqual([
      { starts_at: new Date(utc(a, FUTURE, "10:00")), service_id: a.service },
    ]);
  });

  it("simultaneous actions with one key and two commands: never two successes", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();

    const results = await Promise.all([
      create(a, "10:00", { requestId }),
      create(a, "15:00", { requestId }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.ok && result.error.code === "idempotency_conflict",
      ),
    ).toHaveLength(1);
    expect(await countAppointments(a.business.id)).toBe(1);
  });

  it("binds a key only on success: a failed first attempt leaves it free", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();
    await createOk(a, "10:00");

    failure(await create(a, "10:30", { requestId }), "schedule_conflict");
    const retry = ok(await create(a, "14:00", { requestId }));
    expect(retry.created).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("DST: the repeated autumn hour (Europe/Paris, 2026-10-25)", () => {
  // Clocks go back at 03:00 CEST → 02:00 CET: 02:00–02:59 happens twice.
  const DAY = "2026-10-25";
  const FIRST = "2026-10-25T00:30:00.000Z"; // 02:30 CEST (UTC+2)
  const SECOND = "2026-10-25T01:30:00.000Z"; // 02:30 CET (UTC+1)

  async function paris() {
    return newAgenda({ timezone: "Europe/Paris", bufferMinutes: 0 });
  }

  function update(
    agenda: Agenda,
    appointment: { id: string; version: number },
    fields: Record<string, unknown>,
  ) {
    return updateAppointmentAction({
      appointmentId: appointment.id,
      expectedVersion: appointment.version,
      serviceId: agenda.service,
      clientId: agenda.client,
      ...fields,
    });
  }

  it("needs an explicit occurrence to create at 02:30, then keeps it", async () => {
    const a = await paris();

    failure(await create(a, "02:30", { date: DAY }), "ambiguous_local_time");
    expect(await countAppointments(a.business.id)).toBe(0);

    const first = await createOk(a, "02:30", {
      date: DAY,
      occurrence: "first",
    });
    expect(first).toMatchObject({
      startsAt: FIRST,
      localStartsAt: `${DAY}T02:30`,
      startOccurrence: "first",
      localEndsAt: `${DAY}T02:30`, // 60 min later: the second 02:30
    });

    const second = await createOk(a, "02:30", {
      date: DAY,
      occurrence: "second",
    });
    expect(second).toMatchObject({
      startsAt: SECOND,
      startOccurrence: "second",
    });
  });

  it("keeps the exact UTC instant when only the notes change", async () => {
    const a = await paris();
    const appointment = await createOk(a, "02:30", {
      date: DAY,
      occurrence: "first",
    });

    const edited = ok(
      await update(a, appointment, { internalNotes: "Note seule" }),
    );

    expect(edited).toMatchObject({
      startsAt: FIRST,
      internalNotes: "Note seule",
    });
    expect((await row(appointment.id)).starts_at.toISOString()).toBe(FIRST);
  });

  it("keeps the exact UTC instant when only the client changes", async () => {
    const a = await paris();
    const other = await createClientRecord(
      a.business.id,
      `o-${randomUUID()}@x.test`,
      "Olga",
    );
    const appointment = await createOk(a, "02:30", {
      date: DAY,
      occurrence: "first",
    });

    const edited = ok(await update(a, appointment, { clientId: other }));

    expect(edited).toMatchObject({ startsAt: FIRST, client: { id: other } });
  });

  it("round trip: the time read from the agenda, sent back unchanged, moves nothing", async () => {
    const a = await paris();
    const created = await createOk(a, "02:30", {
      date: DAY,
      occurrence: "first",
    });
    const [loaded] = ok(
      await getAgendaAction({ startDate: DAY, endDate: DAY }),
    ).appointments;
    const [date, time] = loaded!.localStartsAt.split("T") as [string, string];

    // Without occurrence (a form that just resends date and time)…
    const once = ok(
      await update(a, loaded!, { date, time, internalNotes: "1" }),
    );
    expect(once.startsAt).toBe(FIRST);
    // …and with the occurrence read from the agenda.
    const twice = ok(
      await update(a, once, {
        date,
        time,
        occurrence: loaded!.startOccurrence,
        internalNotes: "2",
      }),
    );
    expect(twice.startsAt).toBe(FIRST);
    expect(twice.id).toBe(created.id);
  });

  it("moves to the first or the second 02:30 only when asked explicitly", async () => {
    const a = await paris();
    const appointment = await createOk(a, "10:00", { date: DAY });

    failure(
      await update(a, appointment, { date: DAY, time: "02:30" }),
      "ambiguous_local_time",
    );
    expect((await row(appointment.id)).version).toBe(1);

    const toFirst = ok(
      await update(a, appointment, {
        date: DAY,
        time: "02:30",
        occurrence: "first",
      }),
    );
    expect(toFirst).toMatchObject({
      startsAt: FIRST,
      startOccurrence: "first",
    });

    // Same wall clock, other occurrence: a real move of one hour.
    const toSecond = ok(
      await update(a, toFirst, {
        date: DAY,
        time: "02:30",
        occurrence: "second",
      }),
    );
    expect(toSecond).toMatchObject({
      startsAt: SECOND,
      startOccurrence: "second",
    });
  });

  it("refuses a time skipped in spring, on creation and on move", async () => {
    const a = await paris();
    const appointment = await createOk(a, "10:00", { date: "2027-03-28" });

    const created = failure(
      await create(a, "02:30", { date: "2027-03-28" }),
      "validation_error",
    );
    expect(created?.fieldErrors).toHaveProperty("time");
    failure(
      await update(a, appointment, {
        date: "2027-03-28",
        time: "02:30",
        occurrence: "first",
      }),
      "validation_error",
    );
    expect((await row(appointment.id)).version).toBe(1);
  });

  it("keeps an appointment crossing midnight intact on edit and in both days", async () => {
    const a = await paris();
    // Saturday 23:30 → Sunday 00:30 (the night of the change).
    const appointment = await createOk(a, "23:30", { date: "2026-10-24" });
    expect(appointment).toMatchObject({
      startsAt: "2026-10-24T21:30:00.000Z",
      endsAt: "2026-10-24T22:30:00.000Z",
      localEndsAt: `${DAY}T00:30`,
    });

    const edited = ok(await update(a, appointment, { internalNotes: "Tard" }));
    expect(edited).toMatchObject({
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    });

    for (const date of ["2026-10-24", DAY]) {
      const agenda = ok(
        await getAgendaAction({ startDate: date, endDate: date }),
      );
      expect(agenda.appointments.map((item) => item.id)).toEqual([
        appointment.id,
      ]);
    }
  });

  it("agrees with public booking, which only ever exchanges UTC instants", async () => {
    const a = await paris();
    await setWeeklyHours(a.business.id, [[0, "00:00", "06:00"]]);

    // The public listing offers 02:30 twice, as two distinct instants.
    const { rows } = await db.query<{ starts_at: Date }>(
      "select starts_at from public.get_available_slots($1, $2, $3)",
      [a.business.slug, a.service, DAY],
    );
    const slots = rows.map((slot) => slot.starts_at.toISOString());
    expect(slots).toContain(FIRST);
    expect(slots).toContain(SECOND);

    // A client books the first one; the agenda shows it as such.
    const booking = await createPublicBooking(anonClient(), {
      slug: a.business.slug,
      serviceId: a.service,
      startsAt: FIRST,
      firstName: "Léa",
      email: "lea@x.test",
    });
    as(a.owner);
    const shown = ok(
      await getAgendaAppointmentAction({
        appointmentId: booking.appointmentId,
      }),
    );
    expect(shown).toMatchObject({
      startsAt: FIRST,
      startOccurrence: "first",
      source: "public",
    });

    // Editing it from the agenda without touching the time keeps it there.
    const edited = ok(await update(a, shown, { internalNotes: "Vue" }));
    expect(edited.startsAt).toBe(FIRST);
  });

  it("keeps blocks stable across an edit in the repeated hour", async () => {
    await paris();
    // Block bounds follow the documented rule (later occurrence), which a
    // read → resend round trip reproduces exactly.
    const block = ok(
      await createBlockAction({
        allDay: false,
        startsAt: `${DAY}T02:00`,
        endsAt: `${DAY}T03:00`,
      }),
    );
    const moved = ok(
      await updateBlockAction({
        blockId: block.id,
        expectedVersion: block.version,
        block: {
          allDay: false,
          startsAt: block.localStartsAt,
          endsAt: block.localEndsAt,
          reason: "Même période",
        },
      }),
    );

    expect(block).toMatchObject({
      // 02:00 = second occurrence (CET), 03:00 CET.
      startsAt: "2026-10-25T01:00:00.000Z",
      endsAt: "2026-10-25T02:00:00.000Z",
    });
    expect(moved).toMatchObject({
      startsAt: block.startsAt,
      endsAt: block.endsAt,
    });
  });
});

// ---------------------------------------------------------------------------

describe("no silent truncation", () => {
  it("refuses a range with more exceptions than the cap, beyond PostgREST's 1000 rows", async () => {
    const a = await newAgenda();
    const dayStart = utc(a, FUTURE, "00:00");
    await db.query(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
       select $1, case when i % 2 = 0 then 'blocked' else 'open_override' end::public.availability_exception_kind,
              $2::timestamptz + i * interval '1 minute',
              $2::timestamptz + (i + 1) * interval '1 minute'
       from generate_series(0, 1000) as i`,
      [a.business.id, dayStart],
    );

    const error = failure(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
      "validation_error",
    );
    expect(error?.fieldErrors).toHaveProperty("endDate");

    // At the cap, everything is returned.
    await db.query(
      `delete from public.availability_exceptions
       where business_id = $1 and starts_at >= $2::timestamptz + interval '500 minutes'`,
      [a.business.id, dayStart],
    );
    const agenda = ok(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
    );
    expect(agenda.blocks.length).toBe(250);
    expect(agenda.workingHours.days[0]!.openRanges.length).toBeGreaterThan(1);
  });

  it("refuses a range with more appointments than the cap", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    await db.query(
      `insert into public.appointments (
         business_id, client_id, service_id, starts_at, ends_at,
         service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot
       )
       select $1, $2, $3,
              $4::timestamptz + i * interval '30 minutes',
              $4::timestamptz + (i + 1) * interval '30 minutes',
              'Retouche', 30, 3000
       from generate_series(0, 800) as i`,
      [a.business.id, a.client, a.shortService, utc(a, FUTURE, "00:00")],
    );

    failure(
      await getAgendaAction({ startDate: FUTURE, endDate: dateInDays(40) }),
      "validation_error",
    );
    expect(
      ok(await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }))
        .appointments,
    ).toHaveLength(48);
  });
});

// ---------------------------------------------------------------------------

describe("atomic creation", () => {
  it("leaves no new client behind when the appointment cannot be created", async () => {
    const a = await newAgenda();
    await createOk(a, "10:00");
    const email = `orphan-${randomUUID().slice(0, 8)}@x.test`;
    const firstName = `Orpheline-${randomUUID().slice(0, 8)}`;

    // The client is inserted, then the appointment hits the schedule.
    failure(
      await create(a, "10:30", {
        client: { type: "new", firstName: "Orpheline", email },
      }),
      "schedule_conflict",
    );
    failure(
      await create(a, "10:30", { client: { type: "new", firstName } }),
      "schedule_conflict",
    );

    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from public.clients
       where business_id = $1 and (email = $2 or first_name = $3)`,
      [a.business.id, email, firstName],
    );
    expect(rows[0]!.count).toBe(0);
    expect(await countAppointments(a.business.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("price", () => {
  it("shows the price agreed at booking, not the current catalogue price", async () => {
    const a = await newAgenda();
    const appointment = await createOk(a, "10:00");
    expect(appointment).toMatchObject({ priceCents: 6500, currency: "EUR" });

    await db.query(
      "update public.services set price_cents = 9900 where id = $1",
      [a.service],
    );
    const [shown] = ok(
      await getAgendaAction({ startDate: FUTURE, endDate: FUTURE }),
    ).appointments;
    expect(shown).toMatchObject({ priceCents: 6500 });

    // A change of service takes the price of the new service.
    const changed = ok(
      await updateAppointmentAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        serviceId: a.shortService,
        clientId: a.client,
      }),
    );
    expect(changed).toMatchObject({
      priceCents: 3000,
      startsAt: appointment.startsAt,
    });
  });
});

// ---------------------------------------------------------------------------

describe("DST: existing blocks keep their instants (Europe/Paris, 2026-10-25)", () => {
  const DAY = "2026-10-25";
  // 02:00 and 02:45 happen twice: CEST (first) then CET (second).
  const FIRST_0200 = "2026-10-25T00:00:00.000Z";
  const FIRST_0245 = "2026-10-25T00:45:00.000Z";
  const SECOND_0200 = "2026-10-25T01:00:00.000Z";
  const SECOND_0245 = "2026-10-25T01:45:00.000Z";

  /** A block stored with exact instants (e.g. created in the first occurrence). */
  async function storedBlock(agenda: Agenda, startsAt: string, endsAt: string) {
    await db.query(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at, reason)
       values ($1, 'blocked', $2, $3, 'Initial')`,
      [agenda.business.id, startsAt, endsAt],
    );
    const agendaDay = ok(
      await getAgendaAction({ startDate: DAY, endDate: DAY }),
    );
    return agendaDay.blocks[0]!;
  }

  async function storedRow(blockId: string) {
    const { rows } = await db.query(
      "select starts_at, ends_at, version, reason from public.availability_exceptions where id = $1",
      [blockId],
    );
    return {
      startsAt: (rows[0].starts_at as Date).toISOString(),
      endsAt: (rows[0].ends_at as Date).toISOString(),
      version: rows[0].version as number,
      reason: rows[0].reason as string | null,
    };
  }

  function resend(
    block: {
      id: string;
      version: number;
      localStartsAt: string;
      localEndsAt: string;
    },
    changes: {
      startsAt?: string;
      endsAt?: string;
      reason?: string | null;
    } = {},
  ) {
    return updateBlockAction({
      blockId: block.id,
      expectedVersion: block.version,
      block: {
        allDay: false,
        startsAt: changes.startsAt ?? block.localStartsAt,
        endsAt: changes.endsAt ?? block.localEndsAt,
        reason: "reason" in changes ? changes.reason : "Initial",
      },
    });
  }

  it("shows a block of the first occurrence as such", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await storedBlock(a, FIRST_0200, FIRST_0245);

    expect(block).toMatchObject({
      startsAt: FIRST_0200,
      endsAt: FIRST_0245,
      localStartsAt: `${DAY}T02:00`,
      localEndsAt: `${DAY}T02:45`,
      startOccurrence: "first",
      endOccurrence: "first",
    });
  });

  it("keeps both UTC bounds when only the reason changes", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await storedBlock(a, FIRST_0200, FIRST_0245);

    const edited = ok(await resend(block, { reason: "Nouveau motif" }));

    expect(edited).toMatchObject({
      startsAt: FIRST_0200,
      endsAt: FIRST_0245,
      version: 2,
    });
    expect(await storedRow(block.id)).toEqual({
      startsAt: FIRST_0200,
      endsAt: FIRST_0245,
      version: 2,
      reason: "Nouveau motif",
    });
  });

  it("keeps both UTC bounds for any other non-temporal resend", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await storedBlock(a, FIRST_0200, FIRST_0245);

    // Reason cleared, then the exact same state sent again.
    const cleared = ok(await resend(block, { reason: null }));
    const same = ok(await resend(cleared, { reason: null }));

    expect(same).toMatchObject({
      startsAt: FIRST_0200,
      endsAt: FIRST_0245,
      reason: null,
    });
  });

  it("start unchanged, end changed: only the end is converted", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await storedBlock(a, FIRST_0200, FIRST_0245);

    const edited = ok(await resend(block, { endsAt: `${DAY}T04:00` }));

    expect(edited).toMatchObject({
      startsAt: FIRST_0200, // still the first 02:00
      endsAt: "2026-10-25T03:00:00.000Z", // 04:00 CET
    });
  });

  it("end unchanged, start changed: only the start is converted", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await storedBlock(a, FIRST_0200, FIRST_0245);

    const edited = ok(await resend(block, { startsAt: `${DAY}T01:00` }));

    expect(edited).toMatchObject({
      startsAt: "2026-10-24T23:00:00.000Z", // 01:00 CEST
      endsAt: FIRST_0245, // still the first 02:45
    });
  });

  it("keeps a block of the second occurrence on a round trip", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await storedBlock(a, SECOND_0200, SECOND_0245);
    expect(block).toMatchObject({
      startOccurrence: "second",
      endOccurrence: "second",
    });

    const edited = ok(await resend(block, { reason: "Toujours là" }));
    expect(edited).toMatchObject({
      startsAt: SECOND_0200,
      endsAt: SECOND_0245,
    });
  });

  it("writes nothing from a stale version", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await storedBlock(a, FIRST_0200, FIRST_0245);
    ok(await resend(block, { reason: "Changé ailleurs" }));

    failure(await resend(block, { endsAt: `${DAY}T05:00` }), "stale_block");
    expect(await storedRow(block.id)).toEqual({
      startsAt: FIRST_0200,
      endsAt: FIRST_0245,
      version: 2,
      reason: "Changé ailleurs",
    });
  });

  it("rolls back completely when a changed bound hits an appointment", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    await createOk(a, "03:30", { date: DAY }); // 02:30Z–03:30Z
    const block = await storedBlock(a, FIRST_0200, FIRST_0245);

    failure(
      await resend(block, { endsAt: `${DAY}T04:00`, reason: "Trop long" }),
      "schedule_conflict",
    );
    expect(await storedRow(block.id)).toEqual({
      startsAt: FIRST_0200,
      endsAt: FIRST_0245,
      version: 1,
      reason: "Initial",
    });
  });

  it("still reads a newly typed repeated time as the second occurrence", async () => {
    await newAgenda({ bufferMinutes: 0 });

    const created = ok(
      await createBlockAction({
        allDay: false,
        startsAt: `${DAY}T02:00`,
        endsAt: `${DAY}T02:45`,
      }),
    );
    expect(created).toMatchObject({
      startsAt: SECOND_0200,
      startOccurrence: "second",
    });
  });
});

// ---------------------------------------------------------------------------

describe("canonical client inputs", () => {
  it("gives the same fingerprint to composed and decomposed spellings", async () => {
    const a = await newAgenda();
    const requestId = randomUUID();
    const composed = "Émilie";
    const decomposed = "Émilie";

    const first = ok(
      await create(a, "10:00", {
        requestId,
        client: { type: "new", firstName: decomposed, lastName: decomposed },
        internalNotes: `Pour ${decomposed}`,
      }),
    );
    const retry = ok(
      await create(a, "10:00", {
        requestId,
        client: { type: "new", firstName: composed, lastName: composed },
        internalNotes: `Pour ${composed}`,
      }),
    );

    expect(retry).toMatchObject({
      created: false,
      appointment: { id: first.appointment.id },
    });
    const { rows } = await db.query(
      "select first_name, last_name from public.clients where id = $1",
      [first.appointment.client.id],
    );
    // Stored in NFC too.
    expect(rows[0]).toEqual({ first_name: composed, last_name: composed });
    expect(await countAppointments(a.business.id)).toBe(1);
  });

  it('treats " Test@Example.com " as test@example.com', async () => {
    const a = await newAgenda();
    const email = `test-${randomUUID().slice(0, 8)}@example.com`;
    const existing = await createClientRecord(a.business.id, email, "Tess");
    const [local, domain] = email.split("@") as [string, string];

    const { appointment } = ok(
      await create(a, "10:00", {
        client: {
          type: "new",
          firstName: "Autre",
          email: ` ${local.toUpperCase()}@${domain.replace("example", "Example")} `,
        },
      }),
    );

    expect(appointment.client).toEqual({ id: existing, displayName: "Tess" });
  });
});

// ---------------------------------------------------------------------------

describe("DST guarantees across paths", () => {
  const DAY = "2026-10-25";

  it("first occurrence + longer service colliding: nothing changes", async () => {
    const a = await newAgenda({ timezone: "Europe/Paris", bufferMinutes: 0 });
    const long = await createService(a.business.id, {
      name: "Longue",
      durationMinutes: 90,
    });
    const first = await createOk(a, "02:30", {
      date: DAY,
      occurrence: "first",
    }); // 00:30Z–01:30Z
    await createOk(a, "02:30", { date: DAY, occurrence: "second" }); // 01:30Z–02:30Z

    failure(
      await updateAppointmentAction({
        appointmentId: first.id,
        expectedVersion: first.version,
        date: DAY,
        time: "02:30",
        occurrence: first.startOccurrence,
        serviceId: long,
        clientId: a.client,
      }),
      "schedule_conflict",
    );
    expect(await row(first.id)).toMatchObject({
      starts_at: new Date("2026-10-25T00:30:00.000Z"),
      ends_at: new Date("2026-10-25T01:30:00.000Z"),
      service_id: a.service,
      duration_minutes_snapshot: 60,
      version: 1,
    });
  });

  it("public booking on the second occurrence, then edited from the agenda", async () => {
    const a = await newAgenda({ timezone: "Europe/Paris", bufferMinutes: 0 });
    await setWeeklyHours(a.business.id, [[0, "00:00", "06:00"]]);
    const SECOND = "2026-10-25T01:30:00.000Z";

    const booking = await createPublicBooking(anonClient(), {
      slug: a.business.slug,
      serviceId: a.service,
      startsAt: SECOND,
      firstName: "Léa",
      email: "lea2@x.test",
    });
    as(a.owner);
    const shown = ok(
      await getAgendaAppointmentAction({
        appointmentId: booking.appointmentId,
      }),
    );
    expect(shown).toMatchObject({
      startsAt: SECOND,
      localStartsAt: `${DAY}T02:30`,
      startOccurrence: "second",
    });

    // The form sends back what it read, occurrence included (and without).
    const once = ok(
      await updateAppointmentAction({
        appointmentId: shown.id,
        expectedVersion: shown.version,
        date: DAY,
        time: "02:30",
        occurrence: shown.startOccurrence,
        serviceId: a.service,
        clientId: shown.client.id,
        internalNotes: "Vue",
      }),
    );
    const twice = ok(
      await updateAppointmentAction({
        appointmentId: shown.id,
        expectedVersion: once.version,
        date: DAY,
        time: "02:30",
        occurrence: null,
        serviceId: a.service,
        clientId: shown.client.id,
        internalNotes: "Revue",
      }),
    );
    expect([once.startsAt, twice.startsAt]).toEqual([SECOND, SECOND]);
  });
});

// ---------------------------------------------------------------------------

describe("block validation on resolved instants (Europe/Paris, 2026-10-25)", () => {
  const DAY = "2026-10-25";
  // 02:30 CEST → 02:30 CET: one real hour, both bounds read 02:30.
  const FIRST_0230 = "2026-10-25T00:30:00.000Z";
  const SECOND_0230 = "2026-10-25T01:30:00.000Z";

  async function crossingBlock(agenda: Agenda) {
    await db.query(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at, reason)
       values ($1, 'blocked', $2, $3, 'Initial')`,
      [agenda.business.id, FIRST_0230, SECOND_0230],
    );
    return ok(await getAgendaAction({ startDate: DAY, endDate: DAY }))
      .blocks[0]!;
  }

  function edit(
    block: {
      id: string;
      version: number;
      localStartsAt: string;
      localEndsAt: string;
    },
    changes: {
      startsAt?: string;
      endsAt?: string;
      reason?: string | null;
    } = {},
  ) {
    return updateBlockAction({
      blockId: block.id,
      expectedVersion: block.version,
      block: {
        allDay: false,
        startsAt: changes.startsAt ?? block.localStartsAt,
        endsAt: changes.endsAt ?? block.localEndsAt,
        reason: "reason" in changes ? changes.reason : "Initial",
      },
    });
  }

  async function stored(blockId: string) {
    const { rows } = await db.query(
      "select starts_at, ends_at, version, reason from public.availability_exceptions where id = $1",
      [blockId],
    );
    return {
      startsAt: (rows[0].starts_at as Date).toISOString(),
      endsAt: (rows[0].ends_at as Date).toISOString(),
      version: rows[0].version as number,
      reason: rows[0].reason as string | null,
    };
  }

  it("shows a one-hour block across the repeated hour as 02:30 → 02:30", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await crossingBlock(a);

    expect(block).toMatchObject({
      startsAt: FIRST_0230,
      endsAt: SECOND_0230,
      localStartsAt: `${DAY}T02:30`,
      localEndsAt: `${DAY}T02:30`,
      startOccurrence: "first",
      endOccurrence: "second",
    });
  });

  it("accepts a reason-only edit and keeps both UTC instants", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await crossingBlock(a);

    const edited = ok(await edit(block, { reason: "Pause" }));

    expect(edited).toMatchObject({
      startsAt: FIRST_0230,
      endsAt: SECOND_0230,
      version: 2,
    });
    expect(await stored(block.id)).toEqual({
      startsAt: FIRST_0230,
      endsAt: SECOND_0230,
      version: 2,
      reason: "Pause",
    });
  });

  it("still answers stale_block to an old version, writing nothing", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const block = await crossingBlock(a);
    ok(await edit(block, { reason: "Ailleurs" }));

    failure(await edit(block, { reason: "Trop tard" }), "stale_block");
    expect(await stored(block.id)).toMatchObject({
      version: 2,
      reason: "Ailleurs",
    });
  });

  it("refuses a really empty period, on creation and on edit", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });

    // Same repeated time typed twice: both resolve to the second occurrence.
    failure(
      await createBlockAction({
        allDay: false,
        startsAt: `${DAY}T02:30`,
        endsAt: `${DAY}T02:30`,
      }),
      "validation_error",
    );
    failure(
      await createBlockAction({
        allDay: false,
        startsAt: `${FUTURE}T10:00`,
        endsAt: `${FUTURE}T10:00`,
      }),
      "validation_error",
    );

    const normal = ok(await block(a, "10:00", "11:00"));
    failure(
      await edit(normal, { endsAt: `${FUTURE}T10:00` }),
      "validation_error",
    );
    expect(await stored(normal.id)).toMatchObject({ version: 1 });
  });

  it("refuses a really inverted period, on creation and on edit", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });

    failure(
      await createBlockAction({
        allDay: false,
        startsAt: `${FUTURE}T11:00`,
        endsAt: `${FUTURE}T10:00`,
      }),
      "validation_error",
    );

    const crossing = await crossingBlock(a);
    // New end 01:00 (23:00Z the day before) is really before the start.
    failure(
      await edit(crossing, { endsAt: `${DAY}T01:00` }),
      "validation_error",
    );
    expect(await stored(crossing.id)).toMatchObject({
      startsAt: FIRST_0230,
      endsAt: SECOND_0230,
      version: 1,
    });
  });

  it("behaves as before outside DST transitions", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const created = ok(await block(a, "10:00", "11:00"));

    const moved = ok(
      await edit(created, {
        startsAt: `${FUTURE}T12:00`,
        endsAt: `${FUTURE}T13:30`,
      }),
    );
    expect(moved).toMatchObject({
      startsAt: utc(a, FUTURE, "12:00"),
      endsAt: utc(a, FUTURE, "13:30"),
      version: 2,
    });

    // Scheduling protection untouched: a block still never covers an appointment.
    await createOk(a, "15:00");
    failure(
      await edit(moved, { endsAt: `${FUTURE}T15:30` }),
      "schedule_conflict",
    );
  });

  it("keeps first- and second-occurrence bounds on a round trip", async () => {
    const a = await newAgenda({ bufferMinutes: 0 });
    const crossing = await crossingBlock(a);

    // Resend unchanged, then change only the end (outside the repeated hour).
    const same = ok(await edit(crossing, { reason: "Même" }));
    expect(same).toMatchObject({ startsAt: FIRST_0230, endsAt: SECOND_0230 });

    const longer = ok(await edit(same, { endsAt: `${DAY}T04:00` }));
    expect(longer).toMatchObject({
      startsAt: FIRST_0230, // first occurrence kept
      endsAt: "2026-10-25T03:00:00.000Z",
      startOccurrence: "first",
    });
  });
});

// ---------------------------------------------------------------------------

describe("whole-day blocks cover the real local day", () => {
  const HAVANA = "America/Havana";
  // 2026-11-01: 00:59 CDT → 00:00 CST at 05:00Z; midnight at 04:00Z and 05:00Z.
  const REPEATED = "2026-11-01";
  const HAVANA_START = "2026-11-01T04:00:00.000Z";
  const HAVANA_END = "2026-11-02T05:00:00.000Z";

  function wholeDay(startDate: string, endDate = startDate, reason?: string) {
    return createBlockAction({ allDay: true, startDate, endDate, reason });
  }

  const hours = (block: { startsAt: string; endsAt: string }) =>
    (Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 3_600_000;

  async function stored(blockId: string) {
    const { rows } = await db.query(
      "select starts_at, ends_at, version, reason from public.availability_exceptions where id = $1",
      [blockId],
    );
    return {
      startsAt: (rows[0].starts_at as Date).toISOString(),
      endsAt: (rows[0].ends_at as Date).toISOString(),
      version: rows[0].version as number,
      reason: rows[0].reason as string | null,
    };
  }

  it("Havana, repeated midnight: starts at the first midnight, no free first hour", async () => {
    const a = await newAgenda({ timezone: HAVANA, bufferMinutes: 0 });

    const block = ok(await wholeDay(REPEATED));
    expect(block).toMatchObject({
      startsAt: HAVANA_START,
      endsAt: HAVANA_END,
      localStartsAt: `${REPEATED}T00:00`,
      localEndsAt: "2026-11-02T00:00",
      startOccurrence: "first",
    });
    expect(hours(block)).toBe(25);

    // The first real hour (00:30 before the change) is blocked…
    failure(
      await create(a, "00:30", {
        date: REPEATED,
        occurrence: "first",
        serviceId: a.shortService,
      }),
      "schedule_conflict",
    );
    // …as is the repeated one, and the day after is free.
    failure(
      await create(a, "00:30", {
        date: REPEATED,
        occurrence: "second",
        serviceId: a.shortService,
      }),
      "schedule_conflict",
    );
    await createOk(a, "00:00", {
      date: "2026-11-02",
      serviceId: a.shortService,
    });
  });

  it("Havana: refuses a whole day over an appointment in its first real hour", async () => {
    const a = await newAgenda({ timezone: HAVANA, bufferMinutes: 0 });
    await createOk(a, "00:15", {
      date: REPEATED,
      occurrence: "first",
      serviceId: a.shortService,
    }); // 04:15Z–04:45Z: before the second midnight

    failure(await wholeDay(REPEATED), "schedule_conflict");
  });

  it("23-hour days: spring forward in Paris, skipped midnight in Santiago", async () => {
    await newAgenda({ timezone: "Europe/Paris" });
    const paris = ok(await wholeDay("2027-03-28"));
    expect(paris).toMatchObject({
      startsAt: "2027-03-27T23:00:00.000Z",
      endsAt: "2027-03-28T22:00:00.000Z",
    });
    expect(hours(paris)).toBe(23);

    await newAgenda({ timezone: "America/Santiago" });
    const santiago = ok(await wholeDay("2026-09-06"));
    expect(santiago).toMatchObject({
      startsAt: "2026-09-06T04:00:00.000Z", // 23:59 → 01:00: starts at the gap
      endsAt: "2026-09-07T03:00:00.000Z",
    });
    expect(hours(santiago)).toBe(23);
  });

  it("25-hour days: fall back in Paris, repeated 23:00 in Santiago", async () => {
    await newAgenda({ timezone: "Europe/Paris" });
    const paris = ok(await wholeDay("2026-10-25"));
    expect(paris).toMatchObject({
      startsAt: "2026-10-24T22:00:00.000Z",
      endsAt: "2026-10-25T23:00:00.000Z",
    });
    expect(hours(paris)).toBe(25);

    await newAgenda({ timezone: "America/Santiago" });
    expect(hours(ok(await wholeDay("2027-04-03")))).toBe(25);
  });

  it("30-minute and 2-hour transitions, and a normal day", async () => {
    await newAgenda({ timezone: "Australia/Lord_Howe" });
    expect(hours(ok(await wholeDay("2026-10-04")))).toBe(23.5);

    await newAgenda({ timezone: "Antarctica/Troll" });
    expect(hours(ok(await wholeDay("2026-10-25")))).toBe(26);

    await newAgenda({ timezone: "Europe/Paris" });
    const normal = ok(await wholeDay("2026-11-10", "2026-11-11"));
    expect(normal).toMatchObject({
      startsAt: "2026-11-09T23:00:00.000Z",
      endsAt: "2026-11-11T23:00:00.000Z",
    });
    expect(hours(normal)).toBe(48);
  });

  it("refuses a whole day on a date that does not exist (Apia, 2011-12-30)", async () => {
    await newAgenda({ timezone: "Pacific/Apia" });

    const empty = failure(await wholeDay("2011-12-30"), "validation_error");
    expect(empty?.fieldErrors).toHaveProperty("endDate");
    // Around it, the real days are adjacent: 29 and 31 December only.
    const around = ok(await wholeDay("2011-12-29", "2011-12-31"));
    expect(hours(around)).toBe(48);
  });

  it("changing the reason does not move a whole-day block", async () => {
    await newAgenda({ timezone: HAVANA, bufferMinutes: 0 });
    const block = ok(await wholeDay(REPEATED, REPEATED, "Congés"));

    const edited = ok(
      await updateBlockAction({
        blockId: block.id,
        expectedVersion: block.version,
        block: {
          allDay: true,
          startDate: REPEATED,
          endDate: REPEATED,
          reason: "Formation",
        },
      }),
    );

    expect(await stored(block.id)).toEqual({
      startsAt: HAVANA_START,
      endsAt: HAVANA_END,
      version: 2,
      reason: "Formation",
    });
    expect(edited.version).toBe(2);
  });

  it("answers stale_block to an old version, writing nothing", async () => {
    await newAgenda({ timezone: HAVANA, bufferMinutes: 0 });
    const block = ok(await wholeDay(REPEATED));
    ok(
      await updateBlockAction({
        blockId: block.id,
        expectedVersion: block.version,
        block: {
          allDay: true,
          startDate: REPEATED,
          endDate: REPEATED,
          reason: "Ailleurs",
        },
      }),
    );

    failure(
      await updateBlockAction({
        blockId: block.id,
        expectedVersion: block.version,
        block: { allDay: true, startDate: "2026-11-03", endDate: "2026-11-03" },
      }),
      "stale_block",
    );
    expect(await stored(block.id)).toMatchObject({
      startsAt: HAVANA_START,
      version: 2,
      reason: "Ailleurs",
    });
  });

  it("moves a whole-day closure to another date, and realigns a wrong midnight", async () => {
    const a = await newAgenda({ timezone: HAVANA, bufferMinutes: 0 });
    // A closure stored with the old rule: second midnight, first hour free.
    const { rows } = await db.query<{ id: string }>(
      `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
       values ($1, 'closed', '2026-11-01T05:00:00Z', '2026-11-02T05:00:00Z') returning id`,
      [a.business.id],
    );
    const closure = ok(
      await getAgendaAction({ startDate: REPEATED, endDate: REPEATED }),
    ).blocks[0]!;
    expect(closure.id).toBe(rows[0]!.id);

    // Sent back as the whole day it shows: realigned on the real day.
    const realigned = ok(
      await updateBlockAction({
        blockId: closure.id,
        expectedVersion: closure.version,
        block: { allDay: true, startDate: REPEATED, endDate: REPEATED },
      }),
    );
    expect(realigned).toMatchObject({
      kind: "closed",
      startsAt: HAVANA_START,
      endsAt: HAVANA_END,
    });

    // Moved to another date: that date's real bounds, kind kept.
    const moved = ok(
      await updateBlockAction({
        blockId: closure.id,
        expectedVersion: realigned.version,
        block: { allDay: true, startDate: "2026-11-05", endDate: "2026-11-05" },
      }),
    );
    expect(moved).toMatchObject({
      kind: "closed",
      startsAt: "2026-11-05T05:00:00.000Z",
      endsAt: "2026-11-06T05:00:00.000Z",
    });

    // A settings closure typed from midnight to midnight gets the same bounds.
    const { createAvailabilityException } =
      await import("@/features/availability/data/schedule");
    const settings = await createAvailabilityException(
      a.owner.client,
      { businessId: a.business.id, timezone: HAVANA },
      {
        kind: "closed",
        startsAt: `${REPEATED}T00:00`,
        endsAt: "2026-11-02T00:00",
        reason: null,
      },
    );
    expect(settings).toMatchObject({
      startsAt: HAVANA_START,
      endsAt: HAVANA_END,
    });
  });

  it("reads the whole real day: the range and the block bounds agree", async () => {
    const a = await newAgenda({ timezone: HAVANA, bufferMinutes: 0 });
    // An appointment in the first real hour, before the second midnight.
    const early = await createOk(a, "00:10", {
      date: REPEATED,
      occurrence: "first",
      serviceId: a.shortService,
    });

    const agenda = ok(
      await getAgendaAction({ startDate: REPEATED, endDate: REPEATED }),
    );
    expect(agenda.range).toMatchObject({
      startsAt: HAVANA_START,
      endsAt: HAVANA_END,
    });
    expect(agenda.appointments.map((item) => item.id)).toEqual([early.id]);

    // A whole day on the next date covers exactly that date's read range.
    const block = ok(await wholeDay("2026-11-02"));
    const next = ok(
      await getAgendaAction({ startDate: "2026-11-02", endDate: "2026-11-02" }),
    );
    expect([block.startsAt, block.endsAt]).toEqual([
      next.range.startsAt,
      next.range.endsAt,
    ]);
  });

  it("leaves hourly blocks unchanged", async () => {
    const a = await newAgenda({ timezone: HAVANA, bufferMinutes: 0 });

    const hourly = ok(await block(a, "10:00", "11:30", REPEATED));
    expect(hourly).toMatchObject({
      startsAt: "2026-11-01T15:00:00.000Z",
      endsAt: "2026-11-01T16:30:00.000Z",
    });
    // Repeated non-midnight time: still the second occurrence (engine rule).
    const repeated = ok(await block(a, "00:30", "02:00", REPEATED));
    expect(repeated.startsAt).toBe("2026-11-01T05:30:00.000Z");
    // A period ending at midnight ends where the next day really begins.
    const evening = ok(
      await createBlockAction({
        allDay: false,
        startsAt: "2026-10-31T22:00",
        endsAt: `${REPEATED}T00:00`,
      }),
    );
    expect(evening.endsAt).toBe(HAVANA_START);
  });
});
