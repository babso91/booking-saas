import "server-only";

import type {
  AgendaRangeInput,
  LocalTimeOccurrence,
} from "@/features/agenda/schemas/agenda";
import type { BusinessHourDto } from "@/features/availability/data/schedule";
import type { BusinessContext } from "@/features/businesses/data/business-context";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import {
  addDaysToLocalDate,
  daysBetweenLocalDates,
  localDateRangeToUtc,
  resolveZonedLocal,
  utcToZonedLocal,
  weekdayOfLocalDate,
  zonedOccurrenceOf,
  zonedTimeOnDateToUtc,
} from "@/lib/time/zoned";
import type { Tables } from "@/types/database.generated";

// Read side of the professional agenda. Every query uses the user's client
// (RLS: members only) and is scoped to the business resolved from the
// session. Instants are UTC ISO strings; each one also comes as a wall-clock
// time in the business time zone so the UI never converts dates itself.

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
    startOccurrence: zonedOccurrenceOf(row.starts_at, timezone),
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

export function toBlockDto(row: BlockRow, timezone: string): AgendaBlockDto {
  return {
    id: row.id,
    version: row.version,
    kind: row.kind as AgendaBlockDto["kind"],
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    localStartsAt: utcToZonedLocal(row.starts_at, timezone),
    localEndsAt: utcToZonedLocal(row.ends_at, timezone),
    startOccurrence: zonedOccurrenceOf(row.starts_at, timezone),
    endOccurrence: zonedOccurrenceOf(row.ends_at, timezone),
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

/**
 * UTC bounds of whole local days: [first real instant of startDate, first
 * real instant of endDate + 1) — repeated or skipped midnights included
 * (startOfLocalDate). Used for range reads, day clipping and whole-day
 * blocks, so all of them agree with the agenda UI's notion of a day.
 */
export function localDaysToUtc(
  startDate: string,
  endDate: string,
  timezone: string,
) {
  return localDateRangeToUtc(startDate, endDate, timezone);
}

/**
 * UTC instant of a start chosen by a professional (`date` + `HH:MM`, local).
 * Nothing is chosen on the professional's behalf:
 * - a time skipped in spring does not exist → `validation_error`;
 * - a time of the repeated autumn hour needs `occurrence` (`first` = before
 *   the clocks go back, `second` = after) → `ambiguous_local_time` without it.
 */
export function localStartToUtc(
  date: string,
  time: string,
  timezone: string,
  occurrence?: LocalTimeOccurrence,
) {
  const resolved = resolveZonedLocal(`${date}T${time}`, timezone);

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

  const weekly: BusinessHourDto[] = hours.data.map((row) => ({
    id: row.id,
    weekday: row.weekday,
    startsAt: row.starts_at.slice(0, 5),
    endsAt: row.ends_at.slice(0, 5),
  }));

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
