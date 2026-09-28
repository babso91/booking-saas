import "server-only";

import type {
  AvailabilityExceptionInput,
  ReplaceBusinessHoursInput,
  UpdateBookingSettingsInput,
} from "@/features/availability/schemas/availability";
import type { BusinessContext } from "@/features/businesses/data/business-context";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { utcToZonedLocal, zonedLocalToUtc } from "@/lib/time/zoned";
import type { Tables, TablesUpdate } from "@/types/database.generated";

// Professional management of opening hours, booking rules and exceptions.
// Queries run with the user's client (RLS) and are scoped to the business
// resolved from the session.

type ScheduleContext = Pick<BusinessContext, "businessId" | "timezone">;

export type BusinessHourDto = {
  id: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
};

export type BookingSettingsDto = {
  currency: string;
  slotIntervalMinutes: number;
  bufferMinutes: number;
  minimumBookingNoticeMinutes: number;
  maximumBookingAdvanceDays: number;
};

export type AvailabilityExceptionDto = {
  id: string;
  kind: Tables<"availability_exceptions">["kind"];
  /** UTC instants (ISO 8601). */
  startsAt: string;
  endsAt: string;
  /** Same bounds as wall-clock times in the business time zone. */
  localStartsAt: string;
  localEndsAt: string;
  reason: string | null;
};

// PostgreSQL `time` is rendered as HH:MM:SS; the API speaks HH:MM.
const toHourMinute = (time: string) => time.slice(0, 5);

function toBusinessHourDto(
  row: Pick<
    Tables<"business_hours">,
    "id" | "weekday" | "starts_at" | "ends_at"
  >,
): BusinessHourDto {
  return {
    id: row.id,
    weekday: row.weekday,
    startsAt: toHourMinute(row.starts_at),
    endsAt: toHourMinute(row.ends_at),
  };
}

function toSettingsDto(row: Tables<"business_settings">): BookingSettingsDto {
  return {
    currency: row.currency,
    slotIntervalMinutes: row.slot_interval_minutes,
    bufferMinutes: row.buffer_minutes,
    minimumBookingNoticeMinutes: row.minimum_booking_notice_minutes,
    maximumBookingAdvanceDays: row.maximum_booking_advance_days,
  };
}

function toExceptionDto(
  row: Pick<
    Tables<"availability_exceptions">,
    "id" | "kind" | "starts_at" | "ends_at" | "reason"
  >,
  timezone: string,
): AvailabilityExceptionDto {
  return {
    id: row.id,
    kind: row.kind,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    localStartsAt: utcToZonedLocal(row.starts_at, timezone),
    localEndsAt: utcToZonedLocal(row.ends_at, timezone),
    reason: row.reason,
  };
}

// ---------------------------------------------------------------------------
// Weekly hours
// ---------------------------------------------------------------------------

export async function listBusinessHours(
  client: AppSupabaseClient,
  businessId: string,
): Promise<BusinessHourDto[]> {
  const { data, error } = await client
    .from("business_hours")
    .select("id, weekday, starts_at, ends_at")
    .eq("business_id", businessId)
    .order("weekday")
    .order("starts_at");

  if (error) {
    throw databaseException(error);
  }

  return data.map(toBusinessHourDto);
}

/** Replaces the whole weekly schedule atomically (single SQL function call). */
export async function replaceBusinessHours(
  client: AppSupabaseClient,
  businessId: string,
  input: ReplaceBusinessHoursInput,
): Promise<BusinessHourDto[]> {
  const { data, error } = await client.rpc("replace_business_hours", {
    p_business_id: businessId,
    p_hours: input.hours.map((range) => ({
      weekday: range.weekday,
      starts_at: range.startsAt,
      ends_at: range.endsAt,
    })),
  });

  if (error) {
    throw databaseException(error);
  }

  return data.map(toBusinessHourDto);
}

// ---------------------------------------------------------------------------
// Booking rules
// ---------------------------------------------------------------------------

export async function getBookingSettings(
  client: AppSupabaseClient,
  businessId: string,
): Promise<BookingSettingsDto> {
  const { data, error } = await client
    .from("business_settings")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    throw databaseException(error);
  }
  if (!data) {
    throw new AppException("not_found");
  }

  return toSettingsDto(data);
}

export async function updateBookingSettings(
  client: AppSupabaseClient,
  businessId: string,
  changes: UpdateBookingSettingsInput,
): Promise<BookingSettingsDto> {
  const patch: TablesUpdate<"business_settings"> = {};

  if (changes.slotIntervalMinutes !== undefined)
    patch.slot_interval_minutes = changes.slotIntervalMinutes;
  if (changes.bufferMinutes !== undefined)
    patch.buffer_minutes = changes.bufferMinutes;
  if (changes.minimumBookingNoticeMinutes !== undefined)
    patch.minimum_booking_notice_minutes = changes.minimumBookingNoticeMinutes;
  if (changes.maximumBookingAdvanceDays !== undefined)
    patch.maximum_booking_advance_days = changes.maximumBookingAdvanceDays;

  const { data, error } = await client
    .from("business_settings")
    .update(patch)
    .eq("business_id", businessId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw databaseException(error);
  }
  if (!data) {
    throw new AppException("not_found");
  }

  return toSettingsDto(data);
}

// ---------------------------------------------------------------------------
// Exceptions: closures, holidays, blocked periods, exceptional openings
// ---------------------------------------------------------------------------

const EXCEPTION_COLUMNS = "id, kind, starts_at, ends_at, reason";

function exceptionRow(
  context: ScheduleContext,
  input: AvailabilityExceptionInput,
) {
  const startsAt = zonedLocalToUtc(input.startsAt, context.timezone);
  const endsAt = zonedLocalToUtc(input.endsAt, context.timezone);

  // A range can collapse across a DST gap (e.g. 02:00 → 02:30 on the spring day).
  if (startsAt >= endsAt) {
    throw new AppException("validation_error", {
      fieldErrors: { endsAt: ["La fin doit être après le début."] },
    });
  }

  return {
    kind: input.kind,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    reason: input.reason,
  };
}

/** Exceptions ending after `from` (defaults to now), chronologically. */
export async function listAvailabilityExceptions(
  client: AppSupabaseClient,
  context: ScheduleContext,
  from: Date = new Date(),
): Promise<AvailabilityExceptionDto[]> {
  const { data, error } = await client
    .from("availability_exceptions")
    .select(EXCEPTION_COLUMNS)
    .eq("business_id", context.businessId)
    .gt("ends_at", from.toISOString())
    .order("starts_at");

  if (error) {
    throw databaseException(error);
  }

  return data.map((row) => toExceptionDto(row, context.timezone));
}

export async function createAvailabilityException(
  client: AppSupabaseClient,
  context: ScheduleContext,
  input: AvailabilityExceptionInput,
): Promise<AvailabilityExceptionDto> {
  const { data, error } = await client
    .from("availability_exceptions")
    .insert({
      business_id: context.businessId,
      ...exceptionRow(context, input),
    })
    .select(EXCEPTION_COLUMNS)
    .single();

  if (error) {
    throw databaseException(error);
  }

  return toExceptionDto(data, context.timezone);
}

export async function updateAvailabilityException(
  client: AppSupabaseClient,
  context: ScheduleContext,
  exceptionId: string,
  input: AvailabilityExceptionInput,
): Promise<AvailabilityExceptionDto> {
  const { data, error } = await client
    .from("availability_exceptions")
    .update(exceptionRow(context, input))
    .eq("business_id", context.businessId)
    .eq("id", exceptionId)
    .select(EXCEPTION_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseException(error);
  }
  if (!data) {
    throw new AppException("not_found");
  }

  return toExceptionDto(data, context.timezone);
}

export async function deleteAvailabilityException(
  client: AppSupabaseClient,
  businessId: string,
  exceptionId: string,
): Promise<void> {
  const { data, error } = await client
    .from("availability_exceptions")
    .delete()
    .eq("business_id", businessId)
    .eq("id", exceptionId)
    .select("id");

  if (error) {
    throw databaseException(error);
  }
  if (data.length === 0) {
    throw new AppException("not_found");
  }
}
