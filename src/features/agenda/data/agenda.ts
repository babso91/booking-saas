import "server-only";

import type { AgendaRangeInput } from "@/features/agenda/schemas/agenda";
import type { BusinessHourDto } from "@/features/availability/data/schedule";
import type { BusinessContext } from "@/features/businesses/data/business-context";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import {
  readBusinessTime,
  type BusinessTime,
  type LocalTimeOccurrence,
  type OpenRangeDto,
  type ResolvedLocalTime,
  type ZoneOffsetDto,
} from "@/lib/time/business-time";
import {
  addDaysToLocalDate,
  daysBetweenLocalDates,
} from "@/lib/time/local-date";
import type { Tables } from "@/types/database.generated";

// Read side of the professional agenda. Every query uses the user's client
// (RLS: members only) and is scoped to the business resolved from the
// session. Instants are UTC ISO strings; each one also comes as a wall-clock
// time in the business time zone so the UI never converts dates itself.
//
// Calendar authority: PostgreSQL (public.business_time). Day bounds, opening
// ranges, wall clocks and DST occurrences all come from the database, never
// from Node's own time zone database (src/lib/time/business-time.ts).

export type AgendaContext = Pick<BusinessContext, "businessId" | "timezone">;

// Explicit caps of one agenda read. PostgREST silently stops at max_rows
// (1000): every list is requested with cap + 1 rows, and a read that exceeds
// its cap is refused, never truncated.

/** Appointments overlapping the range. */
export const MAX_AGENDA_APPOINTMENTS = 800;
/** Exceptions overlapping the range: blocks, closures and openings together. */
export const MAX_AGENDA_EXCEPTIONS = 500;
/** Weekly ranges (7 days × 12, the limit of replace_business_hours input). */
export const MAX_WEEKLY_RANGES = 84;

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
  /**
   * `first` / `second` when the start falls in the repeated autumn hour
   * (same local time twice), otherwise null. Send it back as `occurrence`.
   */
  startOccurrence: LocalTimeOccurrence | null;
  /** Time kept free after the appointment (frozen at booking). */
  bufferMinutes: number;
  /** Price agreed at booking (snapshot), in minor units (cents). */
  priceCents: number;
  currency: string;
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
  /** `first` / `second` when a bound falls in the repeated autumn hour. */
  startOccurrence: LocalTimeOccurrence | null;
  endOccurrence: LocalTimeOccurrence | null;
  reason: string | null;
};

export type AgendaTimeRange = OpenRangeDto;

export type AgendaDayDto = {
  /** Local calendar date `YYYY-MM-DD`. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Real bounds of the day: [startsAt, endsAt) (23 h, 25 h… or empty). */
  startsAt: string;
  endsAt: string;
  /**
   * Real opening of that day (weekly hours + exceptional openings), exactly
   * the ranges public availability uses. A weekly range covering a repeated
   * hour may give several ranges.
   */
  openRanges: AgendaTimeRange[];
};

export type AgendaDto = {
  timezone: string;
  /** The business's civil date when the agenda was read. */
  today: string;
  /**
   * UTC offset pieces covering the days read, from PostgreSQL: the UI places
   * instants on its grid with them, never with the browser's time zone data.
   */
  offsets: ZoneOffsetDto[];
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
  price_cents_snapshot, currency,
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
  | "price_cents_snapshot"
  | "currency"
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
  time: BusinessTime,
): AgendaAppointmentDto {
  const start = time.wall(row.starts_at);
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    localStartsAt: start.local,
    localEndsAt: time.wall(row.ends_at).local,
    durationMinutes: row.duration_minutes_snapshot,
    startOccurrence: start.occurrence,
    bufferMinutes: row.buffer_minutes_snapshot,
    priceCents: row.price_cents_snapshot,
    currency: row.currency,
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

export function toBlockDto(row: BlockRow, time: BusinessTime): AgendaBlockDto {
  const start = time.wall(row.starts_at);
  const end = time.wall(row.ends_at);
  return {
    id: row.id,
    version: row.version,
    kind: row.kind as AgendaBlockDto["kind"],
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    localStartsAt: start.local,
    localEndsAt: end.local,
    startOccurrence: start.occurrence,
    endOccurrence: end.occurrence,
    reason: row.reason,
  };
}

/**
 * UTC instant of a start chosen by a professional (`date` + `HH:MM`, local).
 * Nothing is chosen on the professional's behalf:
 * - a time skipped in spring does not exist → `validation_error`;
 * - a time of the repeated autumn hour needs `occurrence` (`first` = before
 *   the clocks go back, `second` = after) → `ambiguous_local_time` without it.
 */
export function localStartToUtc(
  resolved: ResolvedLocalTime,
  occurrence?: LocalTimeOccurrence,
) {
  if (resolved.status === "nonexistent") {
    throw new AppException("validation_error", {
      fieldErrors: {
        time: ["Cette heure n’existe pas ce jour-là (changement d’heure)."],
      },
    });
  }

  if (resolved.status === "exact") return resolved.instant;

  if (!occurrence) {
    throw new AppException("ambiguous_local_time", {
      fieldErrors: {
        occurrence: [
          "Heure en double ce jour-là : précisez first (avant le changement d’heure) ou second (après).",
        ],
      },
    });
  }

  return occurrence === "first" ? resolved.first : resolved.second;
}

function tooMany(message: string): AppException {
  return new AppException("validation_error", {
    fieldErrors: { endDate: [message] },
  });
}

/** Every civil date of [startDate, endDate]. */
export function datesOf(startDate: string, endDate: string) {
  return Array.from(
    { length: daysBetweenLocalDates(startDate, endDate) + 1 },
    (_, offset) => addDaysToLocalDate(startDate, offset),
  );
}

/** Wall clocks of every bound of the rows, in one call to the authority. */
export function wallClocksOf(
  client: AppSupabaseClient,
  context: AgendaContext,
  rows: { starts_at: string; ends_at: string }[],
) {
  return readBusinessTime(client, context.businessId, {
    instants: rows.flatMap((row) => [row.starts_at, row.ends_at]),
  });
}

export async function getAgenda(
  client: AppSupabaseClient,
  context: AgendaContext,
  range: AgendaRangeInput,
): Promise<AgendaDto> {
  const { businessId } = context;
  const dates = datesOf(range.startDate, range.endDate);

  // 1. The days themselves, from the calendar authority: real bounds,
  //    opening ranges and UTC offsets, in one call.
  const calendar = await readBusinessTime(client, businessId, {
    dates,
    openRanges: true,
  });
  const from = calendar.day(range.startDate).startsAt;
  const to = calendar.day(range.endDate).endsAt;

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

  const [appointments, exceptions, hours] = await Promise.all([
    appointmentsQuery,
    client
      .from("availability_exceptions")
      .select(BLOCK_COLUMNS)
      .eq("business_id", businessId)
      .lt("starts_at", to)
      .gt("ends_at", from)
      .order("starts_at")
      .order("id")
      .limit(MAX_AGENDA_EXCEPTIONS + 1),
    client
      .from("business_hours")
      .select("id, weekday, starts_at, ends_at")
      .eq("business_id", businessId)
      .order("weekday")
      .order("starts_at")
      .limit(MAX_WEEKLY_RANGES + 1),
  ]);

  if (appointments.error) throw databaseException(appointments.error);
  if (exceptions.error) throw databaseException(exceptions.error);
  if (hours.error) throw databaseException(hours.error);

  if (appointments.data.length > MAX_AGENDA_APPOINTMENTS) {
    throw tooMany("Trop de rendez-vous sur cette période : réduisez-la.");
  }
  if (exceptions.data.length > MAX_AGENDA_EXCEPTIONS) {
    throw tooMany(
      "Trop de périodes bloquées ou d’ouvertures sur cette période : réduisez-la.",
    );
  }
  if (hours.data.length > MAX_WEEKLY_RANGES) {
    // Not reachable through replace_business_hours input validation.
    throw new AppException("internal", {
      cause: new Error("Weekly schedule exceeds the agenda read cap"),
    });
  }

  // 2. Wall clocks of every item bound, again from the authority (one call;
  //    a long block may start or end far outside the days read).
  const time = await wallClocksOf(client, context, [
    ...appointments.data,
    ...exceptions.data,
  ]);

  const weekly: BusinessHourDto[] = hours.data.map((row) => ({
    id: row.id,
    weekday: row.weekday,
    startsAt: row.starts_at.slice(0, 5),
    endsAt: row.ends_at.slice(0, 5),
  }));

  const blocks = exceptions.data.filter((row) => row.kind !== "open_override");

  return {
    timezone: calendar.timezone,
    today: calendar.today,
    offsets: calendar.offsets,
    range: {
      startDate: range.startDate,
      endDate: range.endDate,
      startsAt: from,
      endsAt: to,
    },
    appointments: appointments.data.map((row) => toAppointmentDto(row, time)),
    blocks: blocks.map((row) => toBlockDto(row, time)),
    workingHours: {
      weekly,
      days: dates.map((date) => ({
        ...calendar.day(date),
        openRanges: calendar.openRanges(date),
      })),
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

  return toAppointmentDto(data, await wallClocksOf(client, context, [data]));
}
