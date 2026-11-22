"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  createService,
  deleteService,
  duplicateService,
  listServices,
  reorderServices,
  setServiceActive,
  updateService,
} from "@/features/services/data/services";
import {
  createServiceSchema,
  deleteServiceSchema,
  duplicateServiceSchema,
  reorderServicesSchema,
  setServiceActiveSchema,
  updateServiceSchema,
} from "@/features/services/schemas/service";

function revalidateServicePages() {
  revalidatePath("/app/services");
  revalidatePath("/b/[slug]", "page");
}

export async function listServicesAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listServices(client, businessId),
  );
}

/**
 * Creates a service. Idempotent by `requestId` (one per form): a retry
 * answers the service it created, `idempotency_conflict` for another
 * command, `service_deleted` once that service was deleted.
 */
export async function createServiceAction(input: unknown) {
  const result = await runBusinessAction(
    createServiceSchema,
    input,
    ({ client, businessId }, data) => createService(client, businessId, data),
  );
  if (result.ok) revalidateServicePages();
  return result;
}

/**
 * Copies a service (point 41), deactivated, right after the original.
 * Idempotent by `requestId`, like a creation.
 */
export async function duplicateServiceAction(input: unknown) {
  const result = await runBusinessAction(
    duplicateServiceSchema,
    input,
    ({ client, businessId }, data) =>
      duplicateService(client, businessId, data),
  );
  if (result.ok) revalidateServicePages();
  return result;
}

/** Writes the changed fields, based on `expectedVersion` (`stale_service`). */
export async function updateServiceAction(input: unknown) {
  const result = await runBusinessAction(
    updateServiceSchema,
    input,
    ({ client, businessId }, data) =>
      updateService(
        client,
        businessId,
        data.serviceId,
        data.changes,
        data.expectedVersion,
      ),
  );
  if (result.ok) revalidateServicePages();
  return result;
}

/** Activates or deactivates; with `expectedVersion`, as updateServiceAction. */
export async function setServiceActiveAction(input: unknown) {
  const result = await runBusinessAction(
    setServiceActiveSchema,
    input,
    ({ client, businessId }, data) =>
      setServiceActive(
        client,
        businessId,
        data.serviceId,
        data.active,
        data.expectedVersion,
      ),
  );
  if (result.ok) revalidateServicePages();
  return result;
}

export async function reorderServicesAction(input: unknown) {
  const result = await runBusinessAction(
    reorderServicesSchema,
    input,
    ({ client, businessId }, data) =>
      reorderServices(client, businessId, data.serviceIds),
  );
  if (result.ok) revalidateServicePages();
  return result;
}

export async function deleteServiceAction(input: unknown) {
  const result = await runBusinessAction(
    deleteServiceSchema,
    input,
    ({ client, businessId }, data) =>
      deleteService(client, businessId, data.serviceId),
  );
  if (result.ok) revalidateServicePages();
  return result;
}
