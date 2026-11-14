// A form her client fills in before a visit (R3-02). PROPOSED contract
// (docs/CLIENT_FORMS_PROPOSAL.md): no server serves it yet. The screen
// takes its actions as a whole; only the design preview and the tests give
// it an in-memory server. No real page shows a form until Cloud provides it.
//
// The server owns everything that matters: who may open the form (a Hub
// session and an attested relation), the visible set of answers (hidden
// ones are refused), the attestation text actually shown, the time.

export type FormFieldType =
  "short_text" | "single_choice" | "boolean" | "attestation";

export type FormFieldDto = {
  /** Stable across versions: conditions refer to it. */
  id: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  help?: string | null;
  /** single_choice only. */
  options?: { id: string; label: string }[];
  /** attestation only: the exact text the client confirms. */
  attestationText?: string;
  /** Shown only when an EARLIER field has this answer; never a script. */
  showIf?: { field: string; equals: string | boolean } | null;
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
  /** The server's word: the client may submit now. */
  canSubmit: boolean;
  /** The pro reviews the answers before they count. */
  review: "none" | "professional";
  fields: FormFieldDto[];
  receipt: { receiptId: string; submittedAt: string } | null;
};

export type AnswerValue = string | boolean;
export type Answers = Record<string, AnswerValue>;

export type FormSubmission = {
  assignmentId: string;
  templateVersionId: string;
  requestId: string;
  answers: {
    fieldId: string;
    value: AnswerValue;
    /** attestation only: the text as displayed, captured with the answer. */
    attestedText?: string;
  }[];
};

export type FormResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; fieldId?: string } };

export type ClientFormActions = {
  read: (assignmentId: string) => Promise<FormResult<ClientFormDto>>;
  submit: (
    input: FormSubmission,
  ) => Promise<
    FormResult<{ receiptId: string; status: FormStatus; submittedAt: string }>
  >;
};

/** Refusals handled by name (proposed codes). */
export const formErrors = {
  notFound: "not_found",
  expired: "form_expired",
  revoked: "form_revoked",
  stale: "stale_form",
  required: "field_required",
  idempotencyConflict: "idempotency_conflict",
} as const;
