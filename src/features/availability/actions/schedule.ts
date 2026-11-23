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
  bookingHorizonDaysSchema,
  bookingNoticeMinutesSchema,
  bookingRhythmSchema,
  createAvailabilityExceptionSchema,
  deleteAvailabilityExceptionSchema,
  listAvailabilityExceptionsSchema,
  replaceBusinessHoursSchema,
  updateAvailabilityExceptionSchema,
  updateBookingSettingsSchema,
} from "@/features/availability/schemas/availability";
import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { AppException } from "@/lib/errors";

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

export async function setBookingHorizonAction(input: unknown) {
  const result = await runBusinessAction(
    z.object({ businessId: z.uuid(), days: bookingHorizonDaysSchema }),
    input,
    async ({ client, businessId, role }, data) => {
      if (businessId !== data.businessId || role === "practitioner") {
        throw new AppException("forbidden");
      }
      const settings = await updateBookingSettings(client, businessId, {
        maximumBookingAdvanceDays: data.days,
      });
      return settings.maximumBookingAdvanceDays;
    },
  );
  if (result.ok) revalidatePath("/b/[slug]", "page");
  return result;
}

/** The minimum notice of online bookings (owner or admin of this business). */
export async function setBookingNoticeAction(input: unknown) {
  const result = await runBusinessAction(
    z.object({ businessId: z.uuid(), minutes: bookingNoticeMinutesSchema }),
    input,
    async ({ client, businessId, role }, data) => {
      if (businessId !== data.businessId || role === "practitioner") {
        throw new AppException("forbidden");
      }
      const settings = await updateBookingSettings(client, businessId, {
        minimumBookingNoticeMinutes: data.minutes,
      });
      return settings.minimumBookingNoticeMinutes;
    },
  );
  if (result.ok) revalidatePath("/b/[slug]", "page");
  return result;
}

/** Point 220: the rhythm of her online bookings, owner or admin. */
export async function setBookingRhythmAction(input: unknown) {
  const result = await runBusinessAction(
    bookingRhythmSchema.extend({ businessId: z.uuid() }),
    input,
    async ({ client, businessId, role }, { businessId: target, ...rhythm }) => {
      if (businessId !== target || role === "practitioner") {
        throw new AppException("forbidden");
      }
      const settings = await updateBookingSettings(client, businessId, rhythm);
      return {
        slotIntervalMinutes: settings.slotIntervalMinutes,
        bufferMinutes: settings.bufferMinutes,
      };
    },
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
