"use server";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  assignForm,
  createTemplate,
  listTemplates,
  publishTemplate,
  readTemplate,
  readVisitForms,
  reviewForm,
  revokeForm,
  saveDraft,
} from "@/features/client-forms/data/forms";
import {
  assignSchema,
  assignmentChangeSchema,
  createTemplateSchema,
  publishSchema,
  saveDraftSchema,
  templateIdSchema,
  visitSchema,
} from "@/features/client-forms/schemas";
import { z } from "zod";

// Her forms, professional side (docs/CLIENT_FORMS_CONTRACT.md): the editor's
// FormEditorActions and the visit's actions. The business is always the
// session's; the database checks role, versions and replays by requestId.

export async function listFormTemplatesAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listTemplates(client, businessId),
  );
}

export async function readFormTemplateAction(input: unknown) {
  return runBusinessAction(
    templateIdSchema,
    input,
    ({ client, businessId }, data) =>
      readTemplate(client, businessId, data.templateId),
  );
}

export async function createFormTemplateAction(input: unknown) {
  return runBusinessAction(
    createTemplateSchema,
    input,
    ({ client, businessId }, data) => createTemplate(client, businessId, data),
  );
}

export async function saveFormDraftAction(input: unknown) {
  return runBusinessAction(
    saveDraftSchema,
    input,
    ({ client, businessId }, data) => saveDraft(client, businessId, data),
  );
}

export async function publishFormTemplateAction(input: unknown) {
  return runBusinessAction(
    publishSchema,
    input,
    ({ client, businessId }, data) => publishTemplate(client, businessId, data),
  );
}

export async function readVisitFormsAction(input: unknown) {
  return runBusinessAction(visitSchema, input, ({ client, businessId }, data) =>
    readVisitForms(client, businessId, data.appointmentId),
  );
}

export async function assignVisitFormAction(input: unknown) {
  return runBusinessAction(
    assignSchema,
    input,
    ({ client, businessId }, data) => assignForm(client, businessId, data),
  );
}

export async function revokeVisitFormAction(input: unknown) {
  return runBusinessAction(
    assignmentChangeSchema,
    input,
    ({ client, businessId }, data) => revokeForm(client, businessId, data),
  );
}

export async function reviewVisitFormAction(input: unknown) {
  return runBusinessAction(
    assignmentChangeSchema,
    input,
    ({ client, businessId }, data) => reviewForm(client, businessId, data),
  );
}
