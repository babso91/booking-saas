import { callAction } from "@/features/auth/client/call-action";
import {
  assignVisitFormAction,
  createFormTemplateAction,
  listFormTemplatesAction,
  publishFormTemplateAction,
  readFormTemplateAction,
  readVisitFormsAction,
  reviewVisitFormAction,
  revokeVisitFormAction,
  saveFormDraftAction,
} from "@/features/client-forms/actions/forms";

import type {
  FormDraft,
  FormEditorActions,
  FormTemplateDto,
} from "./editor/contract";
import type { VisitFormsActions, VisitFormsDto } from "./review/contract";

// The professional's form screens on Cloud's Server Actions
// (docs/CLIENT_FORMS_CONTRACT.md), served as proposed: the answers pass
// through unchanged; an error keeps its code only.

type Answer<T> = { ok: true; data: T } | { ok: false; error: { code: string } };

const plain = async <T>(
  run: () => Promise<
    { ok: true; data: T } | { ok: false; error: { code: string } }
  >,
): Promise<Answer<T>> => {
  const result = await callAction(run as never);
  return (result as Answer<T>).ok
    ? (result as Answer<T>)
    : {
        ok: false,
        error: { code: (result as { error: { code: string } }).error.code },
      };
};

export const realFormEditorActions: FormEditorActions = {
  read: (templateId) =>
    plain<FormTemplateDto>(() => readFormTemplateAction({ templateId })),
  saveDraft: (input) =>
    plain<FormTemplateDto>(() => saveFormDraftAction(input)),
  publish: (input) =>
    plain<FormTemplateDto>(() => publishFormTemplateAction(input)),
};

export const listTemplates = () =>
  plain<FormTemplateDto[]>(() => listFormTemplatesAction());

export const createTemplate = (draft: FormDraft) =>
  plain<FormTemplateDto>(() =>
    createFormTemplateAction({ requestId: crypto.randomUUID(), draft }),
  );

/**
 * A visit's forms. The writes answer with the assignment only (not the
 * visit as proposed): the visit is read again after each, so the screen
 * gets the view it expects. If that read fails, the screen retries with
 * the same requestId and the server replays: nothing is sent twice.
 */
export function realVisitFormsActions(
  appointmentId: string,
): VisitFormsActions {
  const read = () =>
    plain<VisitFormsDto>(() => readVisitFormsAction({ appointmentId }));
  const then = async (
    write: () => Promise<Answer<unknown>>,
  ): Promise<Answer<VisitFormsDto>> => {
    const written = await write();
    return written.ok ? read() : written;
  };
  return {
    read: () => read(),
    assign: (input) => then(() => plain(() => assignVisitFormAction(input))),
    revoke: (input) => then(() => plain(() => revokeVisitFormAction(input))),
    review: (input) => then(() => plain(() => reviewVisitFormAction(input))),
  };
}
