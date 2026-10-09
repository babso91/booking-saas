import "server-only";

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

export type CrmContext = Pick<BusinessContext, "businessId" | "timezone">;

export function displayName(firstName: string, lastName: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ");
}

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

  const rows = data.slice(0, input.limit);
  const last = rows.at(-1);
  const time = await businessInstants(
    client,
    context.businessId,
    rows.flatMap((row) => [
      row.created_at,
      row.last_completed_at,
      row.next_starts_at,
    ]),
  );
  const asOf = data[0]?.as_of ?? after?.asOf ?? time.now;
  if (!asOf) {
    throw new AppException("internal", {
      cause: new Error("crm_list_clients: no reference instant"),
    });
  }

  let nextCursor: string | null = null;
  if (data.length > input.limit && last) {
    const key =
      input.sort === "name"
        ? last.sort_text
        : input.sort === "most_visits"
          ? last.sort_count
          : last.sort_at;
    if (key === null || key === undefined) {
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
    timezone: context.timezone,
    totalCount: Number(data[0]?.total_count ?? 0),
    clients: rows.map((row) => ({
      id: row.id,
      displayName: displayName(row.first_name, row.last_name),
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      createdAt: time.at(row.created_at),
      completedCount: row.completed_count,
      lastCompletedVisitAt: time.optional(row.last_completed_at),
      upcomingCount: row.upcoming_count,
      nextAppointment:
        row.next_appointment_id && row.next_starts_at
          ? {
              id: row.next_appointment_id,
              startsAt: time.at(row.next_starts_at),
            }
          : null,
    })),
    nextCursor,
  };
}
