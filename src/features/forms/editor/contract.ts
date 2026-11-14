// Her form templates (R3-02, pro side). PROPOSED contract
// (docs/CLIENT_FORMS_PROPOSAL.md, "Éditeur"): no server serves it yet. A
// template has one draft she edits and published versions nobody edits:
// publishing freezes the draft as a new version.

import type { FormFieldDto } from "../contract";

export type FormFrequency =
  | { kind: "every_appointment" }
  | { kind: "reuse_completed_for_days"; days: number };

export type FormDraft = {
  title: string;
  intro: string;
  review: "none" | "professional";
  frequency: FormFrequency;
  fields: FormFieldDto[];
};

export type FormTemplateDto = {
  templateId: string;
  status: "draft" | "active" | "retired";
  /** Optimistic lock of the draft. */
  draftVersion: number;
  draft: FormDraft;
  /** Most recent first. */
  published: { versionId: string; number: number; publishedAt: string }[];
};

export type EditorResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type FormEditorActions = {
  read: (templateId: string) => Promise<EditorResult<FormTemplateDto>>;
  saveDraft: (input: {
    templateId: string;
    expectedDraftVersion: number;
    requestId: string;
    draft: FormDraft;
  }) => Promise<EditorResult<FormTemplateDto>>;
  publish: (input: {
    templateId: string;
    expectedDraftVersion: number;
    requestId: string;
  }) => Promise<EditorResult<FormTemplateDto>>;
};

export const editorErrors = {
  versionConflict: "version_conflict",
  invalidTemplate: "invalid_template",
} as const;
