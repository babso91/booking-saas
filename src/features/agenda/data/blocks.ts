import "server-only";

import {
  BLOCK_COLUMNS,
  toBlockDto,
  type AgendaBlockDto,
  type AgendaContext,
} from "@/features/agenda/data/agenda";
import type { BlockInput } from "@/features/agenda/schemas/agenda";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import {
  addDaysToLocalDate,
  utcToZonedLocal,
  zonedLocalToUtc,
} from "@/lib/time/zoned";

// Blocks of the agenda are availability_exceptions of kind 'blocked' (created
// here) or 'closed' (created in the settings). They go through the existing
// write path: RLS-filtered DML whose triggers take the schedule lock and
// refuse any overlap with a non-cancelled appointment (`schedule_conflict`).
// Edits and deletions are conditioned on the version the UI loaded
// (`stale_block`), so a stale screen never overwrites a newer change.

const EDITABLE_KINDS = ["blocked", "closed"] as const;

/** Requested bounds as local wall-clock `YYYY-MM-DDTHH:MM` values. */
function localBounds(input: BlockInput) {
  return input.allDay
    ? {
        start: `${input.startDate}T00:00`,
        end: `${addDaysToLocalDate(input.endDate, 1)}T00:00`,
      }
    : { start: input.startsAt, end: input.endsAt };
}

function blockRow(startsAt: Date, endsAt: Date, reason: string | null) {
  // A short period can collapse across a DST gap (02:00 → 02:30 in spring).
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
function editedBound(stored: string, requested: string, timezone: string) {
  return utcToZonedLocal(stored, timezone) === requested
    ? new Date(stored)
    : zonedLocalToUtc(requested, timezone);
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
  // New bounds follow the engine's rule (zonedLocalToUtc = PostgreSQL
  // `AT TIME ZONE`): a repeated autumn time is the second occurrence.
  const bounds = localBounds(input);
  const { data, error } = await client
    .from("availability_exceptions")
    .insert({
      business_id: context.businessId,
      kind: "blocked",
      ...blockRow(
        zonedLocalToUtc(bounds.start, context.timezone),
        zonedLocalToUtc(bounds.end, context.timezone),
        input.reason,
      ),
    })
    .select(BLOCK_COLUMNS)
    .single();

  if (error) throw databaseException(error);

  return toBlockDto(data, context.timezone);
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

  const bounds = localBounds(input);
  const row = blockRow(
    editedBound(current.starts_at, bounds.start, context.timezone),
    editedBound(current.ends_at, bounds.end, context.timezone),
    input.reason,
  );

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

  return toBlockDto(data, context.timezone);
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
