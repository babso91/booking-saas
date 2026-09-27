"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  createAvailabilityException,
  deleteAvailabilityException,
  getBookingSettings,
  listAvailabilityExceptions,
  listBusinessHours,
  replaceBusinessHours,
  updateAvailabilityException,
  updateBookingSettings,
} from "@/features/availability/data/schedule";
import {
  createAvailabilityExceptionSchema,
  deleteAvailabilityExceptionSchema,
  listAvailabilityExceptionsSchema,
  replaceBusinessHoursSchema,
  updateAvailabilityExceptionSchema,
  updateBookingSettingsSchema,
} from "@/features/availability/schemas/availability";
import { runBusinessAction } from "@/features/businesses/actions/run-business-action";

function revalidateSchedulePages() {
  revalidatePath("/app/settings");
  revalidatePath("/b/[slug]", "page");
}

export async function listBusinessHoursAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listBusinessHours(client, businessId),
  );
}

export async function replaceBusinessHoursAction(input: unknown) {
  const result = await runBusinessAction(
    replaceBusinessHoursSchema,
    input,
    ({ client, businessId }, data) =>
      replaceBusinessHours(client, businessId, data),
  );
  if (result.ok) revalidateSchedulePages();
  return result;
}

export async function getBookingSettingsAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    getBookingSettings(client, businessId),
  );
}

export async function updateBookingSettingsAction(input: unknown) {
  const result = await runBusinessAction(
    updateBookingSettingsSchema,
    input,
    ({ client, businessId }, data) =>
      updateBookingSettings(client, businessId, data),
  );
  if (result.ok) revalidateSchedulePages();
  return result;
}

export async function listAvailabilityExceptionsAction(input?: unknown) {
  return runBusinessAction(
    listAvailabilityExceptionsSchema,
    input,
    ({ client, ...context }, data) =>
      listAvailabilityExceptions(
        client,
        context,
        data?.from ? new Date(data.from) : undefined,
      ),
  );
}

export async function createAvailabilityExceptionAction(input: unknown) {
  const result = await runBusinessAction(
    createAvailabilityExceptionSchema,
    input,
    ({ client, ...context }, data) =>
      createAvailabilityException(client, context, data),
  );
  if (result.ok) revalidateSchedulePages();
  return result;
}

export async function updateAvailabilityExceptionAction(input: unknown) {
  const result = await runBusinessAction(
    updateAvailabilityExceptionSchema,
    input,
    ({ client, ...context }, { exceptionId, ...data }) =>
      updateAvailabilityException(client, context, exceptionId, data),
  );
  if (result.ok) revalidateSchedulePages();
  return result;
}

export async function deleteAvailabilityExceptionAction(input: unknown) {
  const result = await runBusinessAction(
    deleteAvailabilityExceptionSchema,
    input,
    ({ client, businessId }, data) =>
      deleteAvailabilityException(client, businessId, data.exceptionId),
  );
  if (result.ok) revalidateSchedulePages();
  return result;
}
