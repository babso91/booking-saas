import "server-only";

import type {
  CreateServiceInput,
  UpdateServiceInput,
} from "@/features/services/schemas/service";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Tables, TablesUpdate } from "@/types/database.generated";

// Professional data access for services. Every query is issued with the
// user's client (RLS enforced) and additionally scoped to the business
// resolved from the session.

const SERVICE_COLUMNS =
  "id, name, description, duration_minutes, price_cents, active, display_order";

type ServiceRow = Pick<
  Tables<"services">,
  | "id"
  | "name"
  | "description"
  | "duration_minutes"
  | "price_cents"
  | "active"
  | "display_order"
>;

export type ServiceDto = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  active: boolean;
  displayOrder: number;
};

function toServiceDto(row: ServiceRow): ServiceDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
    active: row.active,
    displayOrder: row.display_order,
  };
}

export async function listServices(
  client: AppSupabaseClient,
  businessId: string,
): Promise<ServiceDto[]> {
  const { data, error } = await client
    .from("services")
    .select(SERVICE_COLUMNS)
    .eq("business_id", businessId)
    .order("display_order")
    .order("name")
    .order("id");

  if (error) {
    throw databaseException(error);
  }

  return data.map(toServiceDto);
}

export async function getService(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
): Promise<ServiceDto> {
  const { data, error } = await client
    .from("services")
    .select(SERVICE_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", serviceId)
    .maybeSingle();

  if (error) {
    throw databaseException(error);
  }
  if (!data) {
    throw new AppException("not_found");
  }

  return toServiceDto(data);
}

export async function createService(
  client: AppSupabaseClient,
  businessId: string,
  input: CreateServiceInput,
): Promise<ServiceDto> {
  let displayOrder = input.displayOrder;

  if (displayOrder === undefined) {
    const { data: last, error: lastError } = await client
      .from("services")
      .select("display_order")
      .eq("business_id", businessId)
      .order("display_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastError) {
      throw databaseException(lastError);
    }

    displayOrder = last ? last.display_order + 1 : 0;
  }

  const { data, error } = await client
    .from("services")
    .insert({
      business_id: businessId,
      name: input.name,
      description: input.description,
      duration_minutes: input.durationMinutes,
      price_cents: input.priceCents,
      active: input.active,
      display_order: displayOrder,
    })
    .select(SERVICE_COLUMNS)
    .single();

  if (error) {
    throw databaseException(error);
  }

  return toServiceDto(data);
}

export async function updateService(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
  changes: UpdateServiceInput["changes"],
): Promise<ServiceDto> {
  const patch: TablesUpdate<"services"> = {};

  if (changes.name !== undefined) patch.name = changes.name;
  if (changes.description !== undefined)
    patch.description = changes.description;
  if (changes.durationMinutes !== undefined)
    patch.duration_minutes = changes.durationMinutes;
  if (changes.priceCents !== undefined) patch.price_cents = changes.priceCents;
  if (changes.active !== undefined) patch.active = changes.active;
  if (changes.displayOrder !== undefined)
    patch.display_order = changes.displayOrder;

  const { data, error } = await client
    .from("services")
    .update(patch)
    .eq("business_id", businessId)
    .eq("id", serviceId)
    .select(SERVICE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseException(error);
  }
  // A row of another tenant is invisible under RLS: same answer as a missing id.
  if (!data) {
    throw new AppException("not_found");
  }

  return toServiceDto(data);
}

export function setServiceActive(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
  active: boolean,
) {
  return updateService(client, businessId, serviceId, { active });
}

export async function reorderServices(
  client: AppSupabaseClient,
  businessId: string,
  serviceIds: string[],
): Promise<ServiceDto[]> {
  const { error } = await client.rpc("reorder_services", {
    p_business_id: businessId,
    p_service_ids: serviceIds,
  });

  if (error) {
    throw databaseException(error);
  }

  return listServices(client, businessId);
}

/**
 * Deletes a service that was never booked. Booked services are referenced by
 * appointments (history) and must be deactivated instead.
 */
export async function deleteService(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
): Promise<void> {
  const { data, error } = await client
    .from("services")
    .delete()
    .eq("business_id", businessId)
    .eq("id", serviceId)
    .select("id");

  if (error) {
    throw databaseException(
      error,
      error.code === "23503" ? { conflict: "in_use" } : {},
    );
  }
  if (data.length === 0) {
    throw new AppException("not_found");
  }
}
