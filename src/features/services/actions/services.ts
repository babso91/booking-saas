"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  createService,
  deleteService,
  listServices,
  reorderServices,
  setServiceActive,
  updateService,
} from "@/features/services/data/services";
import {
  createServiceSchema,
  deleteServiceSchema,
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

export async function createServiceAction(input: unknown) {
  const result = await runBusinessAction(
    createServiceSchema,
    input,
    ({ client, businessId }, data) => createService(client, businessId, data),
  );
  if (result.ok) revalidateServicePages();
  return result;
}

export async function updateServiceAction(input: unknown) {
  const result = await runBusinessAction(
    updateServiceSchema,
    input,
    ({ client, businessId }, data) =>
      updateService(client, businessId, data.serviceId, data.changes),
  );
  if (result.ok) revalidateServicePages();
  return result;
}

export async function setServiceActiveAction(input: unknown) {
  const result = await runBusinessAction(
    setServiceActiveSchema,
    input,
    ({ client, businessId }, data) =>
      setServiceActive(client, businessId, data.serviceId, data.active),
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
