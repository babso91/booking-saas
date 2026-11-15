// Shapes served by the forms backend (docs/CLIENT_FORMS_CONTRACT.md). They are
// the ones of the UI's contract (src/features/forms/contract.ts and its
// editor/review contracts); PostgreSQL builds them
// (20261115100000_client_forms.sql).

export type FormFieldType =
  "short_text" | "single_choice" | "boolean" | "attestation";

export type FormFieldDto = {
  id: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  help: string | null;
  options?: { id: string; label: string }[];
  attestationText?: string;
  showIf: { field: string; equals: string | boolean } | null;
};

export type FormStatus =
  | "assigned"
  | "submitted"
  | "under_review"
  | "completed"
  | "expired"
  | "revoked";

export type ClientFormDto = {
  assignmentId: string;
  templateVersionId: string;
  title: string;
  businessName: string;
  intro: string | null;
  status: FormStatus;
  expiresAt: string | null;
  canSubmit: boolean;
  review: "none" | "professional";
  fields: FormFieldDto[];
  receipt: { receiptId: string; submittedAt: string } | null;
};

export type FormReceiptDto = {
  receiptId: string;
  status: FormStatus;
  submittedAt: string;
};

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
  draftVersion: number;
  draft: FormDraft;
  published: { versionId: string; number: number; publishedAt: string }[];
};

export type FormAnswerDto = {
  fieldId: string;
  value: string | boolean;
  attestedText?: string;
  attestedAt?: string;
};

export type ProFormAssignmentDto = {
  assignmentId: string;
  title: string;
  versionNumber: number;
  status: FormStatus;
  sentAt: string;
  expiresAt: string | null;
  review: "none" | "professional";
  version: number;
  submission: {
    submittedAt: string;
    fields: FormFieldDto[];
    answers: FormAnswerDto[];
  } | null;
  reviewedAt: string | null;
};

export type VisitFormsDto = {
  appointmentId: string;
  clientName: string;
  assignments: ProFormAssignmentDto[];
  templates: {
    templateVersionId: string;
    title: string;
    versionNumber: number;
  }[];
};
