import "server-only";

import type { AgendaContext } from "@/features/agenda/data/agenda";
import { clientDisplayName } from "@/features/agenda/data/agenda";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// What the appointment form needs: bookable services and existing clients.
// Both are scoped to the session's business and read under RLS.

export type AgendaServiceDto = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
};

export type AgendaServicesDto = {
  services: AgendaServiceDto[];
  /** Applied after every new appointment (from the booking settings). */
  bufferMinutes: number;
  currency: string;
};

export type AgendaClientDto = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
};

/** Active services only: an inactive service cannot be booked. */
export async function listAgendaServices(
  client: AppSupabaseClient,
  context: AgendaContext,
): Promise<AgendaServicesDto> {
  const [services, settings] = await Promise.all([
    client
      .from("services")
      .select("id, name, duration_minutes, price_cents")
      .eq("business_id", context.businessId)
      .eq("active", true)
      .order("display_order")
      .order("name")
      .order("id"),
    client
      .from("business_settings")
      .select("buffer_minutes, currency")
      .eq("business_id", context.businessId)
      .maybeSingle(),
  ]);

  if (services.error) throw databaseException(services.error);
  if (settings.error) throw databaseException(settings.error);
  if (!settings.data) throw new AppException("not_found");

  return {
    services: services.data.map((row) => ({
      id: row.id,
      name: row.name,
      durationMinutes: row.duration_minutes,
      priceCents: row.price_cents,
    })),
    bufferMinutes: settings.data.buffer_minutes,
    currency: settings.data.currency,
  };
}

/** Clients of this business whose name, email or phone contains `query`. */
export async function searchAgendaClients(
  client: AppSupabaseClient,
  context: AgendaContext,
  query: string,
): Promise<AgendaClientDto[]> {
  const { data, error } = await client.rpc("search_clients", {
    p_business_id: context.businessId,
    p_query: query,
    p_limit: 10,
  });

  if (error) throw databaseException(error);

  return data.map((row) => ({
    id: row.id,
    displayName: clientDisplayName(row),
    email: row.email,
    phone: row.phone,
  }));
}
