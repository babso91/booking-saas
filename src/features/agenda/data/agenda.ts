import "server-only";

import type { AgendaRangeInput } from "@/features/agenda/schemas/agenda";
import {
  listBusinessHours,
  type BusinessHourDto,
} from "@/features/availability/data/schedule";
import type { BusinessContext } from "@/features/businesses/data/business-context";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import {
  addDaysToLocalDate,
  daysBetweenLocalDates,
  isExistingLocalTime,
  utcToZonedLocal,
  weekdayOfLocalDate,
  zonedLocalToUtc,
  zonedTimeOnDateToUtc,
} from "@/lib/time/zoned";
import type { Tables } from "@/types/database.generated";

// Read side of the professional agenda. Every query uses the user's client
// (RLS: members only) and is scoped to the business resolved from the
// session. Instants are UTC ISO strings; each one also comes as a wall-clock
// time in the business time zone so the UI never converts dates itself.

export type AgendaContext = Pick<BusinessContext, "businessId" | "timezone">;

/** Above this, a read is refused instead of being silently truncated. */
export const MAX_AGENDA_APPOINTMENTS = 800;

export type AgendaAppointmentDto = {
  id: string;
  /** Pass it back as `expectedVersion` when editing. */
  version: number;
  status: Tables<"appointments">["status"];
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  durationMinutes: number;
  /** Time kept free after the appointment (frozen at booking). */
  bufferMinutes: number;
  service: { id: string; name: string };
  client: { id: string; displayName: string };
  internalNotes: string | null;
  cancellationReason: string | null;
  /** `public`: booked on the public page; `manual`: added by a professional. */
  source: "public" | "manual";
  createdAt: string;
  updatedAt: string;
};

export type AgendaBlockDto = {
  id: string;
  version: number;
  kind: "blocked" | "closed";
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  reason: string | null;
};

export type AgendaTimeRange = {
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
};

export type AgendaDayDto = {
  /** Local calendar date `YYYY-MM-DD`. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Opening ranges of that day: weekly hours + exceptional openings. */
  openRanges: AgendaTimeRange[];
};

export type AgendaDto = {
  timezone: string;
  range: {
    startDate: string;
    endDate: string;
    startsAt: string;
    endsAt: string;
  };
  appointments: AgendaAppointmentDto[];
  blocks: AgendaBlockDto[];
  workingHours: { weekly: BusinessHourDto[]; days: AgendaDayDto[] };
};

export const APPOINTMENT_COLUMNS = `
  id, version, status, starts_at, ends_at,
  duration_minutes_snapshot, buffer_minutes_snapshot,
  service_id, service_name_snapshot, client_id,
  internal_notes, cancellation_reason, created_by, created_at, updated_at,
  clients!inner(first_name, last_name)
`;

type AppointmentRow = Pick<
  Tables<"appointments">,
  | "id"
  | "version"
  | "status"
  | "starts_at"
  | "ends_at"
  | "duration_minutes_snapshot"
  | "buffer_minutes_snapshot"
  | "service_id"
  | "service_name_snapshot"
  | "client_id"
  | "internal_notes"
  | "cancellation_reason"
  | "created_by"
  | "created_at"
  | "updated_at"
> & { clients: Pick<Tables<"clients">, "first_name" | "last_name"> };

const iso = (value: string | Date) => new Date(value).toISOString();

export function clientDisplayName(client: {
  first_name: string;
  last_name: string | null;
}) {
  return [client.first_name, client.last_name].filter(Boolean).join(" ");
}

export function toAppointmentDto(
  row: AppointmentRow,
  timezone: string,
): AgendaAppointmentDto {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    localStartsAt: utcToZonedLocal(row.starts_at, timezone),
    localEndsAt: utcToZonedLocal(row.ends_at, timezone),
    durationMinutes: row.duration_minutes_snapshot,
    bufferMinutes: row.buffer_minutes_snapshot,
    service: { id: row.service_id, name: row.service_name_snapshot },
    client: { id: row.client_id, displayName: clientDisplayName(row.clients) },
    internalNotes: row.internal_notes,
    cancellationReason: row.cancellation_reason,
    source: row.created_by ? "manual" : "public",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export const BLOCK_COLUMNS = "id, version, kind, starts_at, ends_at, reason";

type BlockRow = Pick<
  Tables<"availability_exceptions">,
  "id" | "version" | "kind" | "starts_at" | "ends_at" | "reason"
>;

export function toBlockDto(row: BlockRow, timezone: string): AgendaBlockDto {
  return {
    id: row.id,
    version: row.version,
    kind: row.kind as AgendaBlockDto["kind"],
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    localStartsAt: utcToZonedLocal(row.starts_at, timezone),
    localEndsAt: utcToZonedLocal(row.ends_at, timezone),
    reason: row.reason,
  };
}

function timeRange(start: Date, end: Date, timezone: string): AgendaTimeRange {
  return {
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    localStartsAt: utcToZonedLocal(start, timezone),
    localEndsAt: utcToZonedLocal(end, timezone),
  };
}

/** UTC bounds of whole local days [startDate 00:00, endDate + 1 00:00). */
export function localDaysToUtc(
  startDate: string,
  endDate: string,
  timezone: string,
) {
  return {
    startsAt: zonedLocalToUtc(`${startDate}T00:00`, timezone),
    endsAt: zonedLocalToUtc(
      `${addDaysToLocalDate(endDate, 1)}T00:00`,
      timezone,
    ),
  };
}

/**
 * UTC instant of a start chosen by a professional (`date` + `HH:MM`, local).
 * A time skipped by a spring-forward transition does not exist: refused
 * rather than silently shifted.
 */
export function localStartToUtc(date: string, time: string, timezone: string) {
  const local = `${date}T${time}`;

  if (!isExistingLocalTime(local, timezone)) {
    throw new AppException("validation_error", {
      fieldErrors: {
        time: ["Cette heure n’existe pas ce jour-là (changement d’heure)."],
      },
    });
  }

  return zonedLocalToUtc(local, timezone);
}

/**
 * Opening ranges per local day, with the same DST rules as availability in
 * PostgreSQL (20260928090000): weekly ranges are converted on each date, a
 * range emptied or inverted by a DST gap is dropped for that day, and
 * exceptional openings are clipped to the day.
 */
export function openRangesByDay(
  startDate: string,
  endDate: string,
  timezone: string,
  weekly: BusinessHourDto[],
  openings: { starts_at: string; ends_at: string }[],
): AgendaDayDto[] {
  const days: AgendaDayDto[] = [];
  const count = daysBetweenLocalDates(startDate, endDate) + 1;

  for (let offset = 0; offset < count; offset += 1) {
    const date = addDaysToLocalDate(startDate, offset);
    const weekday = weekdayOfLocalDate(date);
    const { startsAt: dayStart, endsAt: dayEnd } = localDaysToUtc(
      date,
      date,
      timezone,
    );
    const ranges: [Date, Date][] = [];

    for (const hour of weekly) {
      if (hour.weekday !== weekday) continue;
      const start = zonedTimeOnDateToUtc(date, hour.startsAt, timezone);
      const end = zonedTimeOnDateToUtc(date, hour.endsAt, timezone);
      if (start < end) ranges.push([start, end]);
    }

    for (const opening of openings) {
      const start = new Date(
        Math.max(new Date(opening.starts_at).getTime(), dayStart.getTime()),
      );
      const end = new Date(
        Math.min(new Date(opening.ends_at).getTime(), dayEnd.getTime()),
      );
      if (start < end) ranges.push([start, end]);
    }

    ranges.sort((a, b) => a[0].getTime() - b[0].getTime());
    days.push({
      date,
      weekday,
      openRanges: ranges.map(([start, end]) => timeRange(start, end, timezone)),
    });
  }

  return days;
}

export async function getAgenda(
  client: AppSupabaseClient,
  context: AgendaContext,
  range: AgendaRangeInput,
): Promise<AgendaDto> {
  const { businessId, timezone } = context;
  const { startsAt, endsAt } = localDaysToUtc(
    range.startDate,
    range.endDate,
    timezone,
  );
  const from = startsAt.toISOString();
  const to = endsAt.toISOString();

  let appointmentsQuery = client
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("business_id", businessId)
    .lt("starts_at", to)
    .gt("ends_at", from)
    .order("starts_at")
    .order("id")
    .limit(MAX_AGENDA_APPOINTMENTS + 1);

  if (!range.includeCancelled) {
    appointmentsQuery = appointmentsQuery.neq("status", "cancelled");
  }

  const [appointments, exceptions, weekly] = await Promise.all([
    appointmentsQuery,
    client
      .from("availability_exceptions")
      .select(BLOCK_COLUMNS)
      .eq("business_id", businessId)
      .lt("starts_at", to)
      .gt("ends_at", from)
      .order("starts_at")
      .order("id"),
    listBusinessHours(client, businessId),
  ]);

  if (appointments.error) throw databaseException(appointments.error);
  if (exceptions.error) throw databaseException(exceptions.error);

  if (appointments.data.length > MAX_AGENDA_APPOINTMENTS) {
    throw new AppException("validation_error", {
      fieldErrors: {
        endDate: ["Trop de rendez-vous sur cette période : réduisez-la."],
      },
    });
  }

  const blocks = exceptions.data.filter((row) => row.kind !== "open_override");
  const openings = exceptions.data.filter(
    (row) => row.kind === "open_override",
  );

  return {
    timezone,
    range: {
      startDate: range.startDate,
      endDate: range.endDate,
      startsAt: from,
      endsAt: to,
    },
    appointments: appointments.data.map((row) =>
      toAppointmentDto(row, timezone),
    ),
    blocks: blocks.map((row) => toBlockDto(row, timezone)),
    workingHours: {
      weekly,
      days: openRangesByDay(
        range.startDate,
        range.endDate,
        timezone,
        weekly,
        openings,
      ),
    },
  };
}

export async function getAgendaAppointment(
  client: AppSupabaseClient,
  context: AgendaContext,
  appointmentId: string,
): Promise<AgendaAppointmentDto> {
  const { data, error } = await client
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("business_id", context.businessId)
    .eq("id", appointmentId)
    .maybeSingle();

  if (error) throw databaseException(error);
  if (!data) throw new AppException("appointment_not_found");

  return toAppointmentDto(data, context.timezone);
}
