import "server-only";

import {
  BLOCK_COLUMNS,
  toBlockDto,
  wallClocksOf,
  type AgendaBlockDto,
  type AgendaContext,
} from "@/features/agenda/data/agenda";
import type { BlockInput } from "@/features/agenda/schemas/agenda";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { readBusinessTime, type BusinessTime } from "@/lib/time/business-time";
import { addDaysToLocalDate } from "@/lib/time/local-date";

// Blocks of the agenda are availability_exceptions of kind 'blocked' (created
// here) or 'closed' (created in the settings). They go through the existing
// write path: RLS-filtered DML whose triggers take the schedule lock and
// refuse any overlap with a non-cancelled appointment (`schedule_conflict`).
// Edits and deletions are conditioned on the version the UI loaded
// (`stale_block`), so a stale screen never overwrites a newer change.
// Every wall-clock value is converted by PostgreSQL (public.business_time).

const EDITABLE_KINDS = ["blocked", "closed"] as const;

/**
 * Whole-day bounds: [first real instant of startDate, first real instant of
 * endDate + 1). Deterministic, so they are always recomputed, on creation and
 * on edit: an unchanged whole-day block keeps exactly the same instants, and
 * one stored with a wrong midnight is realigned on the real day.
 */
function wholeDayBounds(
  input: Extract<BlockInput, { allDay: true }>,
  time: BusinessTime,
) {
  const bounds = {
    startsAt: new Date(time.day(input.startDate).startsAt),
    endsAt: new Date(time.day(addDaysToLocalDate(input.endDate, 1)).startsAt),
  };

  // Only dates skipped by the zone (Pacific/Apia, 2011-12-30) are empty.
  if (bounds.startsAt >= bounds.endsAt) {
    throw new AppException("validation_error", {
      fieldErrors: {
        endDate: ["Ces dates n’existent pas dans le fuseau horaire."],
      },
    });
  }

  return bounds;
}

/**
 * The only ordering check of a block: on resolved UTC instants, never on
 * wall-clock strings. Refuses empty and inverted periods, including a short
 * period collapsed by the spring gap (02:00 → 02:30), and accepts a period
 * whose two bounds read the same during the repeated autumn hour.
 */
function blockRow(startsAt: Date, endsAt: Date, reason: string | null) {
  if (startsAt >= endsAt) {
    throw new AppException("validation_error", {
      fieldErrors: { endsAt: ["La fin doit être après le début."] },
    });
  }

  return {
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    reason,
  };
}

/**
 * Bound of an edited block: the stored instant when the local value sent
 * back is the one the block already shows, otherwise a conversion of the new
 * local value.
 *
 * Only a bound that really changes is converted. Converting an unchanged
 * bound again would move a block starting in the first occurrence of the
 * repeated autumn hour (02:00 CEST) to the second one (02:00 CET).
 */
function editedBound(stored: string, requested: string, time: BusinessTime) {
  return time.wall(stored).local === requested
    ? new Date(stored)
    : time.local(requested).bound;
}

/** Everything a block write needs from the calendar authority, in one call. */
function blockTime(
  client: AppSupabaseClient,
  context: AgendaContext,
  input: BlockInput,
  stored: { starts_at: string; ends_at: string } | null = null,
) {
  return readBusinessTime(
    client,
    context.businessId,
    input.allDay
      ? {
          dates: [input.startDate, addDaysToLocalDate(input.endDate, 1)],
        }
      : {
          locals: [input.startsAt, input.endsAt],
          instants: stored ? [stored.starts_at, stored.ends_at] : [],
        },
  );
}

/** Distinguishes "gone" from "changed since loaded" after a 0-row write. */
async function missingOrStale(
  client: AppSupabaseClient,
  context: AgendaContext,
  blockId: string,
): Promise<AppException> {
  const { data, error } = await client
    .from("availability_exceptions")
    .select("id")
    .eq("business_id", context.businessId)
    .eq("id", blockId)
    .in("kind", EDITABLE_KINDS)
    .maybeSingle();

  if (error) return databaseException(error);

  return new AppException(data ? "stale_block" : "block_not_found");
}

export async function createBlock(
  client: AppSupabaseClient,
  context: AgendaContext,
  input: BlockInput,
): Promise<AgendaBlockDto> {
  // Whole days: real local day bounds. Periods: midnight is where the day
  // begins; any other repeated time is its second occurrence (the engine's
  // rule, PostgreSQL `AT TIME ZONE`, private.local_bound).
  const time = await blockTime(client, context, input);
  const { startsAt, endsAt } = input.allDay
    ? wholeDayBounds(input, time)
    : {
        startsAt: time.local(input.startsAt).bound,
        endsAt: time.local(input.endsAt).bound,
      };
  const { data, error } = await client
    .from("availability_exceptions")
    .insert({
      business_id: context.businessId,
      kind: "blocked",
      ...blockRow(startsAt, endsAt, input.reason),
    })
    .select(BLOCK_COLUMNS)
    .single();

  if (error) throw databaseException(error);

  return toBlockDto(data, await wallClocksOf(client, context, [data]));
}

export async function updateBlock(
  client: AppSupabaseClient,
  context: AgendaContext,
  blockId: string,
  expectedVersion: number,
  input: BlockInput,
): Promise<AgendaBlockDto> {
  const { data: current, error: readError } = await client
    .from("availability_exceptions")
    .select(BLOCK_COLUMNS)
    .eq("business_id", context.businessId)
    .eq("id", blockId)
    .in("kind", EDITABLE_KINDS)
    .maybeSingle();

  if (readError) throw databaseException(readError);
  if (!current) throw new AppException("block_not_found");
  if (current.version !== expectedVersion) {
    throw new AppException("stale_block");
  }

  const time = await blockTime(client, context, input, current);
  const { startsAt, endsAt } = input.allDay
    ? wholeDayBounds(input, time)
    : {
        startsAt: editedBound(current.starts_at, input.startsAt, time),
        endsAt: editedBound(current.ends_at, input.endsAt, time),
      };
  const row = blockRow(startsAt, endsAt, input.reason);

  // One UPDATE conditioned on the version read above: a change committed in
  // between is re-checked by PostgreSQL (READ COMMITTED) and makes this write
  // match no row, so the bounds kept above are never applied to a newer block.
  const { data, error } = await client
    .from("availability_exceptions")
    .update(row)
    .eq("business_id", context.businessId)
    .eq("id", blockId)
    .eq("version", expectedVersion)
    .in("kind", EDITABLE_KINDS)
    .select(BLOCK_COLUMNS)
    .maybeSingle();

  if (error) throw databaseException(error);
  if (!data) throw await missingOrStale(client, context, blockId);

  return toBlockDto(data, await wallClocksOf(client, context, [data]));
}

export async function deleteBlock(
  client: AppSupabaseClient,
  context: AgendaContext,
  blockId: string,
  expectedVersion: number,
): Promise<void> {
  const { data, error } = await client
    .from("availability_exceptions")
    .delete()
    .eq("business_id", context.businessId)
    .eq("id", blockId)
    .eq("version", expectedVersion)
    .in("kind", EDITABLE_KINDS)
    .select("id");

  if (error) throw databaseException(error);
  if (data.length === 0) throw await missingOrStale(client, context, blockId);
}
