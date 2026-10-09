import "server-only";

import { z } from "zod";

import type { BusinessContext } from "@/features/businesses/data/business-context";
import {
  decodeDirectoryCursor,
  encodeDirectoryCursor,
} from "@/features/crm/data/cursor";
import { businessInstants } from "@/features/crm/data/instants";
import type { ListClientsInput } from "@/features/crm/schemas/crm";
import type { DirectoryPageDto } from "@/features/crm/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// The customer directory: one page of the business's customers with their
// relationship summary, computed in PostgreSQL (public.crm_list_clients)
// under the user's session (RLS). Metrics come from the same definition as
// the profile (public.crm_client_activity).

/**
 * The business only: its time zone is never taken from the session's
 * context but from the conversion itself (instants.ts).
 */
export type CrmContext = Pick<BusinessContext, "businessId">;

export function displayName(firstName: string, lastName: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ");
}

const instant = z.string();

const directorySchema = z.object({
  asOf: instant,
  totalCount: z.number().int().min(0),
  rows: z.array(
    z.object({
      id: z.uuid(),
      firstName: z.string(),
      lastName: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      createdAt: instant,
      completedCount: z.number().int(),
      lastCompletedAt: instant.nullable(),
      upcomingCount: z.number().int(),
      nextAppointmentId: z.uuid().nullable(),
      nextStartsAt: instant.nullable(),
      sortText: z.string().nullable(),
      sortAt: instant.nullable(),
      sortCount: z.number().int().nullable(),
    }),
  ),
});

export async function listBusinessClients(
  client: AppSupabaseClient,
  context: CrmContext,
  input: ListClientsInput,
): Promise<DirectoryPageDto> {
  const after = input.cursor
    ? decodeDirectoryCursor(input.cursor, {
        sort: input.sort,
        filter: input.filter,
        query: input.query,
      })
    : null;
  const instantKey =
    input.sort === "newest" ||
    input.sort === "last_visit" ||
    input.sort === "next_appointment";

  const { data, error } = await client.rpc("crm_list_clients", {
    p_business_id: context.businessId,
    p_query: input.query,
    p_filter: input.filter,
    p_sort: input.sort,
    p_limit: input.limit,
    p_as_of: after?.asOf,
    p_after_text:
      after && input.sort === "name" ? String(after.key) : undefined,
    p_after_at: after && instantKey ? String(after.key) : undefined,
    p_after_count:
      after && input.sort === "most_visits" ? Number(after.key) : undefined,
    p_after_id: after?.id,
  });

  if (error) throw databaseException(error);

  const parsed = directorySchema.safeParse(data);
  if (!parsed.success) {
    throw new AppException("internal", { cause: parsed.error });
  }
  // The total comes with the page, from the same statement, never from its
  // rows: a page can be empty while customers match.
  const { asOf, totalCount } = parsed.data;
  const rows = parsed.data.rows.slice(0, input.limit);
  const last = rows.at(-1);
  const time = await businessInstants(
    client,
    context.businessId,
    rows.flatMap((row) => [
      row.createdAt,
      row.lastCompletedAt,
      row.nextStartsAt,
    ]),
  );

  let nextCursor: string | null = null;
  if (parsed.data.rows.length > input.limit && last) {
    const key =
      input.sort === "name"
        ? last.sortText
        : input.sort === "most_visits"
          ? last.sortCount
          : last.sortAt;
    if (key === null) {
      throw new AppException("internal", {
        cause: new Error("crm_list_clients: row without sort key"),
      });
    }
    nextCursor = encodeDirectoryCursor({
      // As returned by PostgreSQL (microseconds kept): every page uses the
      // very same reference instant.
      asOf,
      sort: input.sort,
      filter: input.filter,
      query: input.query,
      key,
      id: last.id,
    });
  }

  return {
    asOf: new Date(asOf).toISOString(),
    timezone: time.timezone,
    totalCount,
    clients: rows.map((row) => ({
      id: row.id,
      displayName: displayName(row.firstName, row.lastName),
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      phone: row.phone,
      createdAt: time.at(row.createdAt),
      completedCount: row.completedCount,
      lastCompletedVisitAt: time.optional(row.lastCompletedAt),
      upcomingCount: row.upcomingCount,
      nextAppointment:
        row.nextAppointmentId && row.nextStartsAt
          ? {
              id: row.nextAppointmentId,
              startsAt: time.at(row.nextStartsAt),
            }
          : null,
    })),
    nextCursor,
  };
}
