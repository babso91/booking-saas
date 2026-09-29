import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  cancelAppointmentAction,
  createAppointmentAction,
  createBlockAction,
  deleteBlockAction,
  getAgendaAction,
  getAgendaAppointmentAction,
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
) {
  return transaction.connection.query(
    `select appointment_id from public.agenda_create_appointment(
       p_business_id => $1, p_service_id => $2, p_starts_at => $3,
       p_client_id => $4, p_request_id => $5)`,
    [
      agenda.business.id,
      agenda.service,
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
        bufferMinutes: 15,
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
        openRanges: [
          expect.objectContaining({
            localStartsAt: `${FUTURE}T09:00`,
            localEndsAt: `${FUTURE}T19:00`,
          }),
          expect.objectContaining({
            localStartsAt: `${FUTURE}T19:00`,
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
