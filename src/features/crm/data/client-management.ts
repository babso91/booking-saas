import "server-only";

import { displayName, type CrmContext } from "@/features/crm/data/directory";
import type {
  CreateClientInput,
  UpdateClientInput,
} from "@/features/crm/schemas/client-management";
import type {
  ClientRecordDto,
  CreateClientResultDto,
  UpdateClientResultDto,
} from "@/features/crm/types";
import { AppException, appErrorMessages } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Manual creation and edition of a customer (public.crm_create_client,
// public.crm_update_client), under the user's session (RLS). The customer's
// identity within the business is its canonical email, decided by
// PostgreSQL: an email used by another customer is a conflict that names
// that customer, never a merge. Contract: docs/CRM_CLIENT_MANAGEMENT.md.

const RECORD_COLUMNS =
  "id, first_name, last_name, email, phone, version, created_at, updated_at";

type RecordRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

function toRecord(row: RecordRow): ClientRecordDto {
  return {
    id: row.id,
    displayName: displayName(row.first_name, row.last_name),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** One customer of the session's business, as an edit form uses it. */
export async function getClientRecord(
  client: AppSupabaseClient,
  context: CrmContext,
  clientId: string,
): Promise<ClientRecordDto> {
  const { data, error } = await client
    .from("clients")
    .select(RECORD_COLUMNS)
    .eq("id", clientId)
    .eq("business_id", context.businessId)
    .maybeSingle();

  if (error) throw databaseException(error);
  if (!data) throw new AppException("client_not_found");

  return toRecord(data);
}

/** The error of a write whose request id was used for another command. */
export function writeException(error: Parameters<typeof databaseException>[0]) {
  const exception = databaseException(error);
  if (exception.code !== "idempotency_conflict") return exception;
  return new AppException("idempotency_conflict", {
    message:
      "Cette demande a déjà été utilisée pour un autre enregistrement. Rechargez le formulaire.",
    fieldErrors: exception.fieldErrors,
    cause: error,
  });
}

/** The email belongs to another customer of the business: name it. */
async function emailConflict(
  client: AppSupabaseClient,
  context: CrmContext,
  conflictingId: string,
) {
  const fieldErrors = { email: [appErrorMessages.client_email_conflict] };
  try {
    const existing = await getClientRecord(client, context, conflictingId);
    return new AppException("client_email_conflict", {
      fieldErrors,
      conflict: { clientId: existing.id, displayName: existing.displayName },
    });
  } catch {
    // Removed meanwhile: the conflict stands, without a record to name.
    return new AppException("client_email_conflict", { fieldErrors });
  }
}

export async function createClient(
  client: AppSupabaseClient,
  context: CrmContext,
  input: CreateClientInput,
): Promise<CreateClientResultDto> {
  const { data, error } = await client
    .rpc("crm_create_client", {
      p_business_id: context.businessId,
      p_first_name: input.firstName,
      p_last_name: input.lastName ?? undefined,
      p_email: input.email ?? undefined,
      p_phone: input.phone ?? undefined,
      p_request_id: input.requestId,
    })
    .single();

  if (error) throw writeException(error);
  if (data.status === "email_conflict") {
    throw await emailConflict(client, context, data.client_id);
  }

  return {
    client: await getClientRecord(client, context, data.client_id),
    created: data.status === "created",
  };
}

export async function updateClient(
  client: AppSupabaseClient,
  context: CrmContext,
  input: UpdateClientInput,
): Promise<UpdateClientResultDto> {
  const { data, error } = await client
    .rpc("crm_update_client", {
      p_business_id: context.businessId,
      p_client_id: input.clientId,
      p_expected_version: input.expectedVersion,
      p_first_name: input.firstName,
      p_last_name: input.lastName ?? undefined,
      p_email: input.email ?? undefined,
      p_phone: input.phone ?? undefined,
    })
    .single();

  if (error) throw writeException(error);
  if (data.status === "email_conflict") {
    throw await emailConflict(client, context, data.client_id);
  }

  return {
    client: await getClientRecord(client, context, input.clientId),
    changed: data.status === "updated",
    retained: {
      upcomingAppointmentsWithOtherEmail: data.upcoming_with_other_email,
      queuedEmailsToOtherAddress: data.queued_emails_to_other_address,
    },
  };
}
