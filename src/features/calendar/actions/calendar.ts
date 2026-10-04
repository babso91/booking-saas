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
import {
  disableOutbound,
  enableOutbound,
  getOutboundStatus,
  processOutbound,
  retryOutbound,
  startWriteAuthorization,
} from "@/features/calendar/data/outbound";
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
    async (context, { refresh }) => {
      if (!refresh) return listConnectedCalendars(contextOf(context));
      const deps = getCalendarDeps();
      const calendars = await refreshCalendars(contextOf(context), deps);
      // A time zone change invalidated these: re-project them now.
      const stale = calendars.filter(
        (calendar) => calendar.blocking && calendar.syncStatus === "stale",
      );
      if (stale.length > 0) {
        runAfterResponse("timezone_sync", async () => {
          for (const calendar of stale) await syncCalendar(deps, calendar.id);
        });
      }
      return calendars;
    },
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

// ---------------------------------------------------------------------------
// Outbound: appointments mirrored to a dedicated Google calendar. Same rules:
// tenant from the session only. Contract: CALENDAR_INTEGRATION_CONTRACT.md.
// ---------------------------------------------------------------------------

/** Outbound state, separate from the inbound one (works without configuration). */
export async function getCalendarOutboundStatusAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    getOutboundStatus(contextOf(context), getCalendarEnv() !== null),
  );
}

/**
 * Returns the Google consent URL that adds the write scope to the connected
 * account (incremental authorization). Completing it enables outbound.
 */
export async function startGoogleCalendarWriteAuthorizationAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    startWriteAuthorization(contextOf(context), getCalendarDeps()),
  );
}

async function enableOrAuthorize(context: CalendarContext) {
  const deps = getCalendarDeps();
  const current = await getOutboundStatus(context, true);
  if (!current.writeAuthorized) {
    const { authorizationUrl } = await startWriteAuthorization(context, deps);
    return { status: current, authorizationUrl };
  }
  await enableOutbound(context);
  runAfterResponse("outbound_enable", () =>
    processOutbound(deps, { businessId: context.businessId }),
  );
  return {
    status: await getOutboundStatus(context, true),
    authorizationUrl: null,
  };
}

/**
 * Enables outbound: the dedicated calendar is created after the response.
 * Without the write scope yet, returns the consent URL to open instead
 * (`authorizationUrl`); completing it enables outbound.
 */
export async function enableCalendarOutboundAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    enableOrAuthorize(contextOf(context)),
  );
}

/**
 * After an action required (the dedicated calendar was deleted): a new
 * dedicated calendar is created explicitly, and the changes recorded
 * meanwhile are sent to it. Same contract as enabling.
 */
export async function reactivateCalendarOutboundAction() {
  return runBusinessAction(z.undefined(), undefined, (context) =>
    enableOrAuthorize(contextOf(context)),
  );
}

/** Stops outbound at once. Events already in Google stay there. */
export async function disableCalendarOutboundAction() {
  return runBusinessAction(z.undefined(), undefined, async (context) => {
    await disableOutbound(contextOf(context));
    return getOutboundStatus(contextOf(context), getCalendarEnv() !== null);
  });
}

/** Retries now the changes waiting for a backoff. */
export async function retryCalendarOutboundAction() {
  return runBusinessAction(z.undefined(), undefined, async (context) => {
    const deps = getCalendarDeps();
    await retryOutbound(contextOf(context));
    runAfterResponse("outbound_retry", () =>
      processOutbound(deps, { businessId: context.businessId }),
    );
    return getOutboundStatus(contextOf(context), true);
  });
}
