import "server-only";

import type {
  ClientFormDto,
  FormReceiptDto,
  FormTemplateDto,
  VisitFormsDto,
} from "@/features/client-forms/types";
import type {
  AssignInput,
  AssignmentChangeInput,
  CreateTemplateInput,
  PublishInput,
  SaveDraftInput,
  SubmissionInput,
} from "@/features/client-forms/schemas";
import { AppException, appErrorMessages } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { Json } from "@/types/database.generated";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Forms (docs/CLIENT_FORMS_CONTRACT.md). Every call goes through a database
// function: role, business, versions, replay by requestId and the template /
// answer rules are PostgreSQL's (20261115100000_client_forms.sql).

type Rpc = {
  data: unknown;
  error: Parameters<typeof databaseException>[0] | null;
};
type RpcCaller = (fn: string, args: object) => Promise<Rpc>;

async function call<T>(
  client: AppSupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await (client.rpc as unknown as RpcCaller)(fn, args);
  if (error) {
    // `field_required` names the question (its stable id) in HINT.
    if (error.message === "field_required" && error.hint) {
      throw new AppException("field_required", {
        cause: error,
        fieldErrors: { [error.hint]: [appErrorMessages.field_required] },
      });
    }
    throw databaseException(error);
  }
  return data as T;
}

// --- Professional ----------------------------------------------------------

export const listTemplates = (client: AppSupabaseClient, businessId: string) =>
  call<FormTemplateDto[]>(client, "list_form_templates", {
    p_business_id: businessId,
  });

export const readTemplate = (
  client: AppSupabaseClient,
  businessId: string,
  templateId: string,
) =>
  call<FormTemplateDto>(client, "read_form_template", {
    p_business_id: businessId,
    p_template_id: templateId,
  });

export const createTemplate = (
  client: AppSupabaseClient,
  businessId: string,
  input: CreateTemplateInput,
) =>
  call<FormTemplateDto>(client, "create_form_template", {
    p_business_id: businessId,
    p_request_id: input.requestId,
    p_draft: input.draft as unknown as Json,
  });

export const saveDraft = (
  client: AppSupabaseClient,
  businessId: string,
  input: SaveDraftInput,
) =>
  call<FormTemplateDto>(client, "save_form_draft", {
    p_business_id: businessId,
    p_template_id: input.templateId,
    p_expected_draft_version: input.expectedDraftVersion,
    p_request_id: input.requestId,
    p_draft: input.draft as unknown as Json,
  });

export const publishTemplate = (
  client: AppSupabaseClient,
  businessId: string,
  input: PublishInput,
) =>
  call<FormTemplateDto>(client, "publish_form_template", {
    p_business_id: businessId,
    p_template_id: input.templateId,
    p_expected_draft_version: input.expectedDraftVersion,
    p_request_id: input.requestId,
  });

export const readVisitForms = (
  client: AppSupabaseClient,
  businessId: string,
  appointmentId: string,
) =>
  call<VisitFormsDto>(client, "read_visit_forms", {
    p_business_id: businessId,
    p_appointment_id: appointmentId,
  });

export const assignForm = (
  client: AppSupabaseClient,
  businessId: string,
  input: AssignInput,
) =>
  call<VisitFormsDto["assignments"][number]>(client, "assign_visit_form", {
    p_business_id: businessId,
    p_appointment_id: input.appointmentId,
    p_template_version_id: input.templateVersionId,
    p_request_id: input.requestId,
  });

export const revokeForm = (
  client: AppSupabaseClient,
  businessId: string,
  input: AssignmentChangeInput,
) =>
  call<VisitFormsDto["assignments"][number]>(client, "revoke_visit_form", {
    p_business_id: businessId,
    p_assignment_id: input.assignmentId,
    p_expected_version: input.expectedVersion,
    p_request_id: input.requestId,
  });

export const reviewForm = (
  client: AppSupabaseClient,
  businessId: string,
  input: AssignmentChangeInput,
) =>
  call<VisitFormsDto["assignments"][number]>(client, "review_visit_form", {
    p_business_id: businessId,
    p_assignment_id: input.assignmentId,
    p_expected_version: input.expectedVersion,
    p_request_id: input.requestId,
  });

// --- Client Hub (service role + her session token, like client_hub_*) -----

export const hubForms = (
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
) =>
  call<ClientFormDto[]>(admin, "client_hub_forms", {
    p_session_token: token,
    p_business_id: businessId,
  });

export const hubForm = (
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
  assignmentId: string,
) =>
  call<ClientFormDto>(admin, "client_hub_form", {
    p_session_token: token,
    p_business_id: businessId,
    p_assignment_id: assignmentId,
  });

export const hubSubmit = (
  admin: AppSupabaseClient,
  token: string,
  businessId: string,
  assignmentId: string,
  input: SubmissionInput,
) =>
  call<FormReceiptDto>(admin, "client_hub_submit_form", {
    p_session_token: token,
    p_business_id: businessId,
    p_assignment_id: assignmentId,
    p_template_version_id: input.templateVersionId,
    p_request_id: input.requestId,
    p_answers: input.answers as unknown as Json,
  });
