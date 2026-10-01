"use server";

import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { runAfterResponse } from "@/features/calendar/data/background";
import {
  disconnect,
  getCalendarIntegrationStatus,
  listConflicts,
  listConnectedCalendars,
  refreshCalendars,
  setBlockingCalendars,
  startConnect,
  syncNow,
  type CalendarContext,
} from "@/features/calendar/data/connection";
import { getCalendarDeps } from "@/features/calendar/data/deps";
import { syncCalendar } from "@/features/calendar/data/sync";
import {
  listCalendarConflictsSchema,
  listConnectedCalendarsSchema,
  updateBlockingCalendarsSchema,
} from "@/features/calendar/schemas/calendar";
import { getCalendarEnv } from "@/lib/env/server";

// Official server interface of the calendar integration for the future UI.
// Every action resolves user and business from the session
// (runBusinessAction); none accepts a business, connection or user id.
// Contract: docs/CALENDAR_INTEGRATION_CONTRACT.md.

const contextOf = ({
  client,
  userId,
  businessId,
}: CalendarContext): CalendarContext => ({ client, userId, businessId });

/** Connection state and calendars (works without configuration). */
export async function getCalendarIntegrationStatusAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    getCalendarIntegrationStatus(contextOf(context), getCalendarEnv() !== null),
  );
}

/** Returns the Google consent URL to open (top-level navigation). */
export async function startGoogleCalendarConnectAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    startConnect(contextOf(context), getCalendarDeps()),
  );
}

export async function listConnectedCalendarsAction(input?: unknown) {
  return runBusinessAction(
    listConnectedCalendarsSchema,
    input,
    (context, { refresh }) =>
      refresh
        ? refreshCalendars(contextOf(context), getCalendarDeps())
        : listConnectedCalendars(contextOf(context)),
  );
}

/**
 * Replaces the set of blocking calendars. Deselected calendars stop blocking
 * at once; selected ones are synced after the response.
 */
export async function updateBlockingCalendarsAction(input: unknown) {
  return runBusinessAction(
    updateBlockingCalendarsSchema,
    input,
    async (context, { calendarIds }) => {
      const deps = getCalendarDeps();
      const result = await setBlockingCalendars(
        contextOf(context),
        deps,
        calendarIds,
      );
      runAfterResponse("selection_sync", async () => {
        await result.cleanup();
        for (const calendarId of result.toSync)
          await syncCalendar(deps, calendarId);
      });
      return result.calendars;
    },
  );
}

/** Synchronises the blocking calendars now (bounded to ~20 s). */
export async function syncGoogleCalendarNowAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    syncNow(contextOf(context), getCalendarDeps()),
  );
}

export async function disconnectGoogleCalendarAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    disconnect(contextOf(context), getCalendarDeps()),
  );
}

/** Appointments overlapped by an external busy period (reported only). */
export async function listCalendarConflictsAction(input: unknown) {
  return runBusinessAction(
    listCalendarConflictsSchema,
    input,
    (context, range) => listConflicts(contextOf(context), range),
  );
}
