import "server-only";

import type {
  CreateServiceInput,
  UpdateServiceInput,
} from "@/features/services/schemas/service";
import { AppException, appErrorMessages } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Tables, TablesUpdate } from "@/types/database.generated";

// Professional data access for services. Every query is issued with the
// user's client (RLS enforced) and additionally scoped to the business
// resolved from the session. Creation is one SQL function call
// (public.create_service, idempotent by request); edits are a compare and
// swap on the version the professional read (services.version, owned by the
// database).

const SERVICE_COLUMNS =
  "id, name, description, duration_minutes, price_cents, active, display_order, version";

type ServiceRow = Pick<
  Tables<"services">,
  | "id"
  | "name"
  | "description"
  | "duration_minutes"
  | "price_cents"
  | "active"
  | "display_order"
  | "version"
>;

export type ServiceDto = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  active: boolean;
  displayOrder: number;
  /** Pass it back as `expectedVersion` to edit this service. */
  version: number;
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
    version: row.version,
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

/**
 * Creates a service, once per `requestId`: a retry of the same command (a
 * lost answer, a double submission) answers the service it created, as it
 * is now. Two requests create two services, even with the same name.
 */
export async function createService(
  client: AppSupabaseClient,
  businessId: string,
  input: CreateServiceInput,
): Promise<ServiceDto> {
  const { data, error } = await client
    .rpc("create_service", {
      p_business_id: businessId,
      p_request_id: input.requestId,
      p_name: input.name,
      p_description: input.description ?? undefined,
      p_duration_minutes: input.durationMinutes,
      p_price_cents: input.priceCents,
      p_active: input.active,
      p_display_order: input.displayOrder,
    })
    .single();

  if (error) {
    throw databaseException(error);
  }
  // This request created a service, deleted since: never created again.
  if (data.status === "deleted") {
    throw serviceDeleted();
  }

  try {
    return await getService(client, businessId, data.service_id);
  } catch (error) {
    // A replay answered just before a concurrent deletion committed.
    if (error instanceof AppException && error.code === "not_found") {
      throw serviceDeleted();
    }
    throw error;
  }
}

function serviceDeleted() {
  return new AppException("service_deleted", {
    fieldErrors: { requestId: [appErrorMessages.service_deleted] },
  });
}

type ServiceChanges = UpdateServiceInput["changes"];

function servicePatch(changes: ServiceChanges): TablesUpdate<"services"> {
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

  return patch;
}

/** Whether the service already has every value of `patch`. */
function hasValues(row: ServiceRow, patch: TablesUpdate<"services">) {
  return (Object.keys(patch) as (keyof typeof patch)[]).every(
    (column) => row[column as keyof ServiceRow] === patch[column],
  );
}

/**
 * Writes only the changed fields, if the service is still at
 * `expectedVersion` (one UPDATE: the compare and swap is its WHERE, so two
 * concurrent edits of one version never both apply). Otherwise:
 *   - `not_found` when there is no such service of this business;
 *   - the service as it is, when it already has exactly these values (a
 *     retried edit, whatever the version);
 *   - `stale_service`: it changed since it was read; nothing is written.
 * Without `expectedVersion` (activation only) the write is by value.
 */
async function writeService(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
  changes: ServiceChanges,
  expectedVersion: number | undefined,
): Promise<ServiceDto> {
  const patch = servicePatch(changes);

  let query = client
    .from("services")
    .update(patch)
    .eq("business_id", businessId)
    .eq("id", serviceId);
  if (expectedVersion !== undefined)
    query = query.eq("version", expectedVersion);

  const { data, error } = await query.select(SERVICE_COLUMNS).maybeSingle();

  if (error) {
    throw databaseException(error);
  }
  if (data) {
    return toServiceDto(data);
  }

  // Nothing written: a row of another tenant is invisible under RLS, same
  // answer as a missing id.
  const { data: current, error: readError } = await client
    .from("services")
    .select(SERVICE_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", serviceId)
    .maybeSingle();

  if (readError) {
    throw databaseException(readError);
  }
  if (!current) {
    throw new AppException("not_found");
  }
  if (hasValues(current, patch)) {
    return toServiceDto(current);
  }
  throw new AppException("stale_service", {
    fieldErrors: { expectedVersion: [appErrorMessages.stale_service] },
  });
}

export function updateService(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
  changes: ServiceChanges,
  expectedVersion: number,
): Promise<ServiceDto> {
  return writeService(client, businessId, serviceId, changes, expectedVersion);
}

/** By value; with `expectedVersion`, refused if the service changed since. */
export function setServiceActive(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
  active: boolean,
  expectedVersion?: number,
): Promise<ServiceDto> {
  return writeService(
    client,
    businessId,
    serviceId,
    { active },
    expectedVersion,
  );
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
