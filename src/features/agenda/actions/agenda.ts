"use server";

import { revalidatePath } from "next/cache";

import { getAgenda, getAgendaAppointment } from "@/features/agenda/data/agenda";
import {
  createManualAppointment,
  setAppointmentStatus,
  updateAppointment,
} from "@/features/agenda/data/appointments";
import {
  createBlock,
  deleteBlock,
  updateBlock,
} from "@/features/agenda/data/blocks";
import {
  listAgendaServices,
  searchAgendaClients,
} from "@/features/agenda/data/lookups";
import {
  agendaRangeSchema,
  appointmentIdSchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  createBlockSchema,
  deleteBlockSchema,
  searchClientsSchema,
  setAppointmentStatusSchema,
  updateAppointmentSchema,
  updateBlockSchema,
} from "@/features/agenda/schemas/agenda";
import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { kickCalendarOutbound } from "@/features/calendar/data/outbound-kick";
import { readBusinessToday } from "@/lib/time/business-time";
import { z } from "zod";

// Official server interface of the professional agenda. Every action resolves
// the business from the session (runBusinessAction), validates its input and
// returns an ActionResult with a stable error code. Contract:
// docs/PROFESSIONAL_AGENDA_CONTRACT.md.

function revalidateAgenda() {
  revalidatePath("/app", "layout");
  // Availability shown on the public page depends on the same schedule.
  revalidatePath("/b/[slug]", "page");
}

export async function getAgendaAction(input: unknown) {
  return runBusinessAction(
    agendaRangeSchema,
    input,
    ({ client, businessId, timezone }, range) =>
      getAgenda(client, { businessId, timezone }, range),
  );
}

export async function getAgendaAppointmentAction(input: unknown) {
  return runBusinessAction(
    appointmentIdSchema,
    input,
    ({ client, businessId, timezone }, { appointmentId }) =>
      getAgendaAppointment(client, { businessId, timezone }, appointmentId),
  );
}

/** The business's date today and when it ends, from PostgreSQL. */
export async function getAgendaTodayAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    readBusinessToday(client, businessId),
  );
}

export async function listAgendaServicesAction() {
  return runBusinessAction(
    z.undefined(),
    undefined,
    ({ client, businessId, timezone }) =>
      listAgendaServices(client, { businessId, timezone }),
  );
}

export async function searchAgendaClientsAction(input: unknown) {
  return runBusinessAction(
    searchClientsSchema,
    input,
    ({ client, businessId, timezone }, { query }) =>
      searchAgendaClients(client, { businessId, timezone }, query),
  );
}

export async function createAppointmentAction(input: unknown) {
  const result = await runBusinessAction(
    createAppointmentSchema,
    input,
    async ({ client, businessId, timezone }, data) => {
      const created = await createManualAppointment(
        client,
        { businessId, timezone },
        data,
      );
      // Google mirror after the response (committed, never awaited here).
      kickCalendarOutbound({ businessId });
      return created;
    },
  );
  if (result.ok) revalidateAgenda();
  return result;
}

export async function updateAppointmentAction(input: unknown) {
  const result = await runBusinessAction(
    updateAppointmentSchema,
    input,
    async ({ client, businessId, timezone }, data) => {
      const updated = await updateAppointment(
        client,
        { businessId, timezone },
        data,
      );
      kickCalendarOutbound({ businessId });
      return updated;
    },
  );
  if (result.ok) revalidateAgenda();
  return result;
}

export async function setAppointmentStatusAction(input: unknown) {
  const result = await runBusinessAction(
    setAppointmentStatusSchema,
    input,
    async ({ client, businessId, timezone }, data) => {
      const changed = await setAppointmentStatus(
        client,
        { businessId, timezone },
        data,
      );
      kickCalendarOutbound({ businessId });
      return changed;
    },
  );
  if (result.ok) revalidateAgenda();
  return result;
}

/** Shortcut for setAppointmentStatusAction({ status: "cancelled" }). */
export async function cancelAppointmentAction(input: unknown) {
  const result = await runBusinessAction(
    cancelAppointmentSchema,
    input,
    async ({ client, businessId, timezone }, data) => {
      const cancelled = await setAppointmentStatus(
        client,
        { businessId, timezone },
        {
          appointmentId: data.appointmentId,
          expectedVersion: data.expectedVersion,
          status: "cancelled",
          cancellationReason: data.reason,
        },
      );
      kickCalendarOutbound({ businessId });
      return cancelled;
    },
  );
  if (result.ok) revalidateAgenda();
  return result;
}

export async function createBlockAction(input: unknown) {
  const result = await runBusinessAction(
    createBlockSchema,
    input,
    ({ client, businessId, timezone }, data) =>
      createBlock(client, { businessId, timezone }, data),
  );
  if (result.ok) revalidateAgenda();
  return result;
}

export async function updateBlockAction(input: unknown) {
  const result = await runBusinessAction(
    updateBlockSchema,
    input,
    ({ client, businessId, timezone }, data) =>
      updateBlock(
        client,
        { businessId, timezone },
        data.blockId,
        data.expectedVersion,
        data.block,
      ),
  );
  if (result.ok) revalidateAgenda();
  return result;
}

export async function deleteBlockAction(input: unknown) {
  const result = await runBusinessAction(
    deleteBlockSchema,
    input,
    ({ client, businessId, timezone }, data) =>
      deleteBlock(
        client,
        { businessId, timezone },
        data.blockId,
        data.expectedVersion,
      ),
  );
  if (result.ok) revalidateAgenda();
  return result;
}
