import "server-only";

import { startOfWeek, visibleRange } from "@/features/agenda/client/dates";
import {
  agendaRangeWithBuffers,
  restrictToDays,
} from "@/features/agenda/client/layout";
import {
  getAgenda,
  type AgendaContext,
  type AgendaDto,
} from "@/features/agenda/data/agenda";
import type { AppSupabaseClient } from "@/lib/supabase/types";

/**
 * The week of `date` for "Aujourd’hui", read exactly as the agenda reads a
 * week when free time matters (RLS: members only): from the day before its
 * Monday, so that a visit over by then whose buffer still holds the first
 * minutes of the week is known (Sunday 23:30–23:50 with 30 minutes of
 * buffer: Monday is taken until 00:20); then only what reaches the week's
 * own days. That Sunday is not one of them, and its visit is not one of
 * Monday's: it only holds time.
 */
export async function readTodayWeek(
  client: AppSupabaseClient,
  context: AgendaContext,
  date: string,
): Promise<AgendaDto> {
  const { days } = visibleRange("week", startOfWeek(date));
  const read = await getAgenda(client, context, {
    ...agendaRangeWithBuffers(days),
    includeCancelled: false,
  });
  return restrictToDays(read, days, { buffers: true });
}
