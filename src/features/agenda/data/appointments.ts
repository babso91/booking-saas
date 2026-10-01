import "server-only";

import {
  getAgendaAppointment,
  localStartToUtc,
  type AgendaAppointmentDto,
  type AgendaContext,
} from "@/features/agenda/data/agenda";
import type {
  CreateAppointmentInput,
  SetAppointmentStatusInput,
  UpdateAppointmentInput,
} from "@/features/agenda/schemas/agenda";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { readBusinessTime } from "@/lib/time/business-time";

// Appointment writes of the agenda. Each is a single SQL function call
// (supabase/migrations/20260930090000_professional_agenda.sql): schedule
// lock, server-side duration and buffer, exclusion constraint and block
// triggers all run in one transaction. The browser never supplies a duration,
// an end or a business. A typed start is resolved by PostgreSQL
// (public.business_time), never with Node's time zone database.

export type CreatedAppointmentDto = {
  appointment: AgendaAppointmentDto;
  /** false when the same requestId had already created this appointment. */
  created: boolean;
};

export async function createManualAppointment(
  client: AppSupabaseClient,
  context: AgendaContext,
  input: CreateAppointmentInput,
): Promise<CreatedAppointmentDto> {
  const startsAt = await resolvedStart(
    client,
    context,
    `${input.date}T${input.time}`,
    input.occurrence,
  );
  const clientFields =
    input.client.type === "existing"
      ? { p_client_id: input.client.clientId }
      : {
          p_client_first_name: input.client.firstName,
          p_client_last_name: input.client.lastName ?? undefined,
          p_client_email: input.client.email ?? undefined,
          p_client_phone: input.client.phone ?? undefined,
        };

  const { data, error } = await client
    .rpc("agenda_create_appointment", {
      p_business_id: context.businessId,
      p_service_id: input.serviceId,
      p_starts_at: startsAt.toISOString(),
      p_internal_notes: input.internalNotes ?? undefined,
      p_request_id: input.requestId,
      ...clientFields,
    })
    .single();

  if (error) throw databaseException(error);

  return {
    appointment: await getAgendaAppointment(
      client,
      context,
      data.appointment_id,
    ),
    created: data.created,
  };
}

async function resolvedStart(
  client: AppSupabaseClient,
  context: AgendaContext,
  local: string,
  occurrence: CreateAppointmentInput["occurrence"],
) {
  const time = await readBusinessTime(client, context.businessId, {
    locals: [local],
  });
  return localStartToUtc(time.local(local), occurrence);
}

/**
 * New start requested by an edit, or undefined to keep the stored instant.
 *
 * An edit that does not change the time must never convert wall-clock time
 * back to UTC: in the repeated autumn hour that would move a "first
 * occurrence" appointment by one hour. The time counts as unchanged when it
 * is absent, or equal to the loaded `localStartsAt` with no other
 * occurrence requested. The version check of the RPC guarantees the
 * appointment compared here is the one being edited.
 */
async function requestedStart(
  client: AppSupabaseClient,
  context: AgendaContext,
  input: UpdateAppointmentInput,
): Promise<string | undefined> {
  if (input.date === undefined || input.time === undefined) return undefined;

  const current = await getAgendaAppointment(
    client,
    context,
    input.appointmentId,
  );
  const unchanged =
    current.localStartsAt === `${input.date}T${input.time}` &&
    (input.occurrence === undefined ||
      input.occurrence === current.startOccurrence ||
      current.startOccurrence === null);

  if (unchanged) return undefined;

  return (
    await resolvedStart(
      client,
      context,
      `${input.date}T${input.time}`,
      input.occurrence,
    )
  ).toISOString();
}

export async function updateAppointment(
  client: AppSupabaseClient,
  context: AgendaContext,
  input: UpdateAppointmentInput,
): Promise<AgendaAppointmentDto> {
  const startsAt = await requestedStart(client, context, input);

  const { error } = await client.rpc("agenda_update_appointment", {
    p_business_id: context.businessId,
    p_appointment_id: input.appointmentId,
    p_expected_version: input.expectedVersion,
    p_starts_at: startsAt,
    p_service_id: input.serviceId,
    p_client_id: input.clientId,
    p_internal_notes: input.internalNotes ?? undefined,
  });

  if (error) throw databaseException(error);

  return getAgendaAppointment(client, context, input.appointmentId);
}

export async function setAppointmentStatus(
  client: AppSupabaseClient,
  context: AgendaContext,
  input: SetAppointmentStatusInput,
): Promise<AgendaAppointmentDto> {
  const { error } = await client.rpc("agenda_set_appointment_status", {
    p_business_id: context.businessId,
    p_appointment_id: input.appointmentId,
    p_expected_version: input.expectedVersion,
    p_status: input.status,
    p_cancellation_reason: input.cancellationReason ?? undefined,
  });

  if (error) throw databaseException(error);

  return getAgendaAppointment(client, context, input.appointmentId);
}
