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

// Appointment writes of the agenda. Each is a single SQL function call
// (supabase/migrations/20260930090000_professional_agenda.sql): schedule
// lock, server-side duration and buffer, exclusion constraint and block
// triggers all run in one transaction. The browser never supplies a duration,
// an end or a business.

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
  const startsAt = localStartToUtc(input.date, input.time, context.timezone);
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

export async function updateAppointment(
  client: AppSupabaseClient,
  context: AgendaContext,
  input: UpdateAppointmentInput,
): Promise<AgendaAppointmentDto> {
  const startsAt = localStartToUtc(input.date, input.time, context.timezone);

  const { error } = await client.rpc("agenda_update_appointment", {
    p_business_id: context.businessId,
    p_appointment_id: input.appointmentId,
    p_expected_version: input.expectedVersion,
    p_starts_at: startsAt.toISOString(),
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
