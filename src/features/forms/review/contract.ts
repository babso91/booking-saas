// The forms of one visit, from her side (R3-02, pro side), as served
// (docs/CLIENT_FORMS_CONTRACT.md). The panel takes its actions as a whole:
// the agenda gives it the real ones (real-pro-actions.ts), the preview and
// the tests an in-memory server.
//
// She sees what is asked of her client for this visit, sends a form,
// withdraws one not yet answered, and reads the answers as they were sent
// (the attestation text as shown) before marking them read.

import type { AnswerValue, FormFieldDto, FormStatus } from "../contract";

export type ProFormAssignmentDto = {
  assignmentId: string;
  /** The template's name and the version that was sent. */
  title: string;
  versionNumber: number;
  status: FormStatus;
  sentAt: string;
  expiresAt: string | null;
  /** The pro reviews before it counts. */
  review: "none" | "professional";
  /** Optimistic lock of the assignment. */
  version: number;
  /** Present once the client has sent it. */
  submission: {
    submittedAt: string;
    fields: FormFieldDto[];
    answers: { fieldId: string; value: AnswerValue; attestedText?: string }[];
  } | null;
  reviewedAt: string | null;
};

export type SendableTemplateDto = {
  templateVersionId: string;
  title: string;
  versionNumber: number;
};

export type VisitFormsDto = {
  appointmentId: string;
  clientName: string;
  assignments: ProFormAssignmentDto[];
  /** Published templates she can send for this visit. */
  templates: SendableTemplateDto[];
};

export type ReviewResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type VisitFormsActions = {
  read: (appointmentId: string) => Promise<ReviewResult<VisitFormsDto>>;
  assign: (input: {
    appointmentId: string;
    templateVersionId: string;
    requestId: string;
  }) => Promise<ReviewResult<VisitFormsDto>>;
  revoke: (input: {
    assignmentId: string;
    expectedVersion: number;
    requestId: string;
  }) => Promise<ReviewResult<VisitFormsDto>>;
  review: (input: {
    assignmentId: string;
    expectedVersion: number;
    requestId: string;
  }) => Promise<ReviewResult<VisitFormsDto>>;
};

export const reviewErrors = {
  versionConflict: "version_conflict",
  alreadySubmitted: "form_already_submitted",
  alreadyAssigned: "form_already_assigned",
} as const;
