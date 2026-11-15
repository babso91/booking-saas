import "server-only";

import type {
  CancelAppointmentInput,
  RescheduleAppointmentInput,
} from "@/features/client-hub/schemas/appointment-actions";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// « Annuler ou déplacer » from her Hub (docs/CLIENT_HUB_CONTRACT.md). The
// database authorizes (session, relation, appointment), freezes nothing new,
// checks the policy frozen with the appointment at its own clock, and
// replays by requestId (20261115120000_hub_appointment_actions.sql).

export type ClientHubAppointmentAction = {
  allowed: boolean;
  deadlineAt: string | null;
  reason:
    | "policy_cutoff_passed"
    | "policy_unavailable"
    | "appointment_not_editable"
    | null;
};

export type ClientHubAppointmentActions = {
  version: number;
  cancel: ClientHubAppointmentAction;
  reschedule: ClientHubAppointmentAction;
} | null;

export type ClientHubRescheduleSlots = {
  date: string;
  timezone: string;
  slots: {
    startsAt: string;
    endsAt: string;
    localStartsAt: string;
    localEndsAt: string;
  }[];
};

type Rpc = {
  data: unknown;
  error: Parameters<typeof databaseException>[0] | null;
};
type RpcCaller = (fn: string, args: object) => Promise<Rpc>;

async function call<T>(admin: AppSupabaseClient, fn: string, args: object) {
  const { data, error } = await (admin.rpc as unknown as RpcCaller)(fn, args);
  if (error) throw databaseException(error);
  return data as T;
}

/** The appointment detail after the change (with its new `actions`). */
export const cancelAppointment = (
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
  appointmentId: string,
  input: CancelAppointmentInput,
) =>
  call<Record<string, unknown>>(admin, "client_hub_cancel_appointment", {
    p_session_token: token,
    p_business_id: businessId,
    p_appointment_id: appointmentId,
    p_expected_version: input.expectedVersion,
    p_request_id: input.requestId,
  });

export const rescheduleAppointment = (
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
  appointmentId: string,
  input: RescheduleAppointmentInput,
) =>
  call<Record<string, unknown>>(admin, "client_hub_reschedule_appointment", {
    p_session_token: token,
    p_business_id: businessId,
    p_appointment_id: appointmentId,
    p_expected_version: input.expectedVersion,
    p_request_id: input.requestId,
    p_starts_at: input.startsAt,
  });

export const rescheduleSlots = (
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
  appointmentId: string,
  date: string,
) =>
  call<ClientHubRescheduleSlots>(admin, "client_hub_reschedule_slots", {
    p_session_token: token,
    p_business_id: businessId,
    p_appointment_id: appointmentId,
    p_date: date,
  });
