import "server-only";

import {
  BLOCK_COLUMNS,
  localDaysToUtc,
  toBlockDto,
  type AgendaBlockDto,
  type AgendaContext,
} from "@/features/agenda/data/agenda";
import type { BlockInput } from "@/features/agenda/schemas/agenda";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { zonedLocalToUtc } from "@/lib/time/zoned";

// Blocks of the agenda are availability_exceptions of kind 'blocked' (created
// here) or 'closed' (created in the settings). They go through the existing
// write path: RLS-filtered DML whose triggers take the schedule lock and
// refuse any overlap with a non-cancelled appointment (`schedule_conflict`).
// Edits and deletions are conditioned on the version the UI loaded
// (`stale_block`), so a stale screen never overwrites a newer change.

const EDITABLE_KINDS = ["blocked", "closed"] as const;

function blockBounds(context: AgendaContext, input: BlockInput) {
  const { startsAt, endsAt } = input.allDay
    ? localDaysToUtc(input.startDate, input.endDate, context.timezone)
    : {
        startsAt: zonedLocalToUtc(input.startsAt, context.timezone),
        endsAt: zonedLocalToUtc(input.endsAt, context.timezone),
      };

  // A short period can collapse across a DST gap (02:00 → 02:30 in spring).
  if (startsAt >= endsAt) {
    throw new AppException("validation_error", {
      fieldErrors: { endsAt: ["La fin doit être après le début."] },
    });
  }

  return {
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    reason: input.reason,
  };
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
  const { data, error } = await client
    .from("availability_exceptions")
    .insert({
      business_id: context.businessId,
      kind: "blocked",
      ...blockBounds(context, input),
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
  // One UPDATE: under READ COMMITTED a concurrent change is re-checked
  // against the version condition after its commit, never overwritten.
  const { data, error } = await client
    .from("availability_exceptions")
    .update(blockBounds(context, input))
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
