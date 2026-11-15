import {
  formErrors,
  type ClientFormActions,
  type ClientFormDto,
  type FormFieldDto,
  type FormResult,
  type FormSubmission,
} from "./contract";
import { missingAnswers, visibleFields } from "./engine";

// An in-memory server of the PROPOSED client-form contract, for the preview
// and the tests only: hidden answers refused, a request id replayed, a
// newer version said once.

const fail = (code: string, fieldId?: string): FormResult<never> => ({
  ok: false,
  error: fieldId ? { code, fieldId } : { code },
});

export const sampleFields: FormFieldDto[] = [
  {
    id: "q-lenses",
    type: "boolean",
    label: "Portez-vous des lentilles de contact ?",
    required: true,
    help: "Il faudra les retirer pendant la séance.",
  },
  {
    id: "q-eyes",
    type: "single_choice",
    label: "Vos yeux sont-ils sensibles ?",
    required: true,
    options: [
      { id: "no", label: "Non" },
      { id: "little", label: "Un peu" },
      { id: "very", label: "Très" },
    ],
  },
  {
    id: "q-eyes-detail",
    type: "short_text",
    label: "Qu’est-ce qui les irrite d’habitude ?",
    required: true,
    showIf: { field: "q-eyes", equals: "very" },
  },
  {
    id: "q-style",
    type: "short_text",
    label: "Un effet que vous aimeriez ?",
    required: false,
    help: "Naturel, ouvert, une photo dont vous me parlerez…",
  },
  {
    id: "q-consent",
    type: "attestation",
    label: "Avant la séance",
    required: true,
    attestationText:
      "J’ai lu les conseils de préparation et je signalerai toute gêne pendant la séance.",
  },
];

export function sampleForm(overrides: Partial<ClientFormDto> = {}) {
  return {
    assignmentId: "fa-1",
    templateVersionId: "tv-3",
    title: "Préparer votre rehaussement de cils",
    businessName: "Atelier Maëlys",
    intro:
      "Quelques questions pour préparer votre venue. Seule votre praticienne lit vos réponses.",
    status: "assigned",
    expiresAt: "2026-11-20T18:00:00.000Z",
    canSubmit: true,
    review: "professional",
    fields: sampleFields,
    receipt: null,
    ...overrides,
  } satisfies ClientFormDto;
}

export function memoryClientForm(
  start: ClientFormDto = sampleForm(),
  options: {
    delayMs?: number;
    /** The pro publishes this version before the first submission. */
    newerVersion?: { templateVersionId: string; fields: FormFieldDto[] };
  } = {},
) {
  let form = structuredClone(start);
  let newer = options.newerVersion;
  const receipts = new Map<
    string,
    { payload: string; result: FormResult<never> | ReturnType<typeof ok> }
  >();
  let count = 0;
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  const ok = (data: {
    receiptId: string;
    status: ClientFormDto["status"];
    submittedAt: string;
  }) => ({ ok: true as const, data });

  function submitNow(input: FormSubmission) {
    if (input.assignmentId !== form.assignmentId)
      return fail(formErrors.notFound);
    if (form.status === "expired") return fail(formErrors.expired);
    if (form.status === "revoked") return fail(formErrors.revoked);
    if (newer) {
      form = { ...form, ...newer };
      newer = undefined;
    }
    if (input.templateVersionId !== form.templateVersionId)
      return fail(formErrors.stale);
    if (!form.canSubmit) return fail("not_allowed");
    const answers = Object.fromEntries(
      input.answers.map((answer) => [answer.fieldId, answer.value]),
    );
    const shown = new Set(
      visibleFields(form.fields, answers).map((field) => field.id),
    );
    if (input.answers.some((answer) => !shown.has(answer.fieldId)))
      return fail("hidden_answer");
    for (const answer of input.answers) {
      const field = form.fields.find((item) => item.id === answer.fieldId)!;
      if (
        field.type === "attestation" &&
        answer.attestedText !== field.attestationText
      )
        return fail(formErrors.stale);
    }
    const missing = Object.keys(missingAnswers(form.fields, answers));
    if (missing.length) return fail(formErrors.required, missing[0]);
    const status = form.review === "professional" ? "submitted" : "completed";
    const receipt = {
      receiptId: `r-${(count += 1)}`,
      submittedAt: new Date().toISOString(),
    };
    form = { ...form, status, canSubmit: false, receipt };
    return ok({ ...receipt, status });
  }

  const actions: ClientFormActions = {
    async read(assignmentId) {
      await pause();
      if (assignmentId !== form.assignmentId) return fail(formErrors.notFound);
      return { ok: true, data: structuredClone(form) };
    },
    async submit(input) {
      await pause();
      const payload = JSON.stringify(input.answers);
      const earlier = receipts.get(input.requestId);
      if (earlier)
        return earlier.payload === payload
          ? earlier.result
          : fail(formErrors.idempotencyConflict);
      const result = submitNow(input);
      if (result.ok) receipts.set(input.requestId, { payload, result });
      return result;
    },
  };
  return {
    actions,
    get form() {
      return form;
    },
  };
}
