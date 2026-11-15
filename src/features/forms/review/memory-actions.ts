import { sampleFields } from "../memory-actions";
import {
  reviewErrors,
  type ReviewResult,
  type VisitFormsActions,
  type VisitFormsDto,
} from "./contract";

// An in-memory server of the pro-side forms contract, for the
// preview and the tests only. Nothing is sent to anyone.

const fail = (code: string): ReviewResult<never> => ({
  ok: false,
  error: { code },
});

export function sampleVisitForms(): VisitFormsDto {
  return {
    appointmentId: "a-visit",
    clientName: "Lina",
    templates: [
      {
        templateVersionId: "tv-3",
        title: "Préparer votre rehaussement de cils",
        versionNumber: 3,
      },
      {
        templateVersionId: "tv-consent",
        title: "Consentement photo",
        versionNumber: 1,
      },
    ],
    assignments: [
      {
        assignmentId: "fa-1",
        title: "Préparer votre rehaussement de cils",
        versionNumber: 3,
        status: "submitted",
        sentAt: "2026-11-13T09:00:00.000Z",
        expiresAt: "2026-11-20T18:00:00.000Z",
        review: "professional",
        version: 2,
        submission: {
          submittedAt: "2026-11-14T08:30:00.000Z",
          fields: sampleFields,
          answers: [
            { fieldId: "q-lenses", value: true },
            { fieldId: "q-eyes", value: "very" },
            { fieldId: "q-eyes-detail", value: "Le mascara waterproof" },
            {
              fieldId: "q-consent",
              value: true,
              attestedText: sampleFields[4]!.attestationText,
            },
          ],
        },
        reviewedAt: null,
      },
    ],
  };
}

export function memoryVisitForms(
  options: { delayMs?: number; start?: VisitFormsDto; now?: () => number } = {},
) {
  const state = structuredClone(options.start ?? sampleVisitForms());
  const answered = new Map<string, ReviewResult<VisitFormsDto>>();
  const now = options.now ?? (() => Date.parse("2026-11-15T10:00:00.000Z"));
  let count = 0;
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  async function once(
    requestId: string,
    run: () => ReviewResult<VisitFormsDto>,
  ) {
    await pause();
    const earlier = answered.get(requestId);
    if (earlier) return earlier;
    const result = run();
    if (result.ok) answered.set(requestId, result);
    return result;
  }
  const find = (id: string) =>
    state.assignments.find((a) => a.assignmentId === id);
  const ok = () => ({ ok: true as const, data: structuredClone(state) });

  const actions: VisitFormsActions = {
    async read(appointmentId) {
      await pause();
      return appointmentId === state.appointmentId ? ok() : fail("not_found");
    },
    assign: ({ templateVersionId, requestId }) =>
      once(requestId, () => {
        const template = state.templates.find(
          (t) => t.templateVersionId === templateVersionId,
        );
        if (!template) return fail("not_found");
        const open = state.assignments.some(
          (a) =>
            a.title === template.title &&
            (a.status === "assigned" || a.status === "submitted"),
        );
        if (open) return fail(reviewErrors.alreadyAssigned);
        state.assignments.push({
          assignmentId: `fa-${(count += 1) + 1}`,
          title: template.title,
          versionNumber: template.versionNumber,
          status: "assigned",
          sentAt: new Date(now()).toISOString(),
          expiresAt: new Date(now() + 5 * 86_400_000).toISOString(),
          review: "professional",
          version: 1,
          submission: null,
          reviewedAt: null,
        });
        return ok();
      }),
    revoke: ({ assignmentId, expectedVersion, requestId }) =>
      once(requestId, () => {
        const item = find(assignmentId);
        if (!item) return fail("not_found");
        if (item.version !== expectedVersion)
          return fail(reviewErrors.versionConflict);
        if (item.status !== "assigned")
          return fail(reviewErrors.alreadySubmitted);
        item.status = "revoked";
        item.version += 1;
        return ok();
      }),
    review: ({ assignmentId, expectedVersion, requestId }) =>
      once(requestId, () => {
        const item = find(assignmentId);
        if (!item) return fail("not_found");
        if (item.version !== expectedVersion)
          return fail(reviewErrors.versionConflict);
        if (item.status !== "submitted" && item.status !== "under_review")
          return fail("not_reviewable");
        item.status = "completed";
        item.reviewedAt = new Date(now()).toISOString();
        item.version += 1;
        return ok();
      }),
  };
  return {
    actions,
    get state() {
      return state;
    },
    /** The client sends her answers meanwhile (tests and preview only). */
    clientSubmits(assignmentId: string) {
      const item = find(assignmentId);
      if (!item) return;
      item.status = "submitted";
      item.version += 1;
      item.submission = {
        submittedAt: new Date(now()).toISOString(),
        fields: sampleFields,
        answers: [{ fieldId: "q-lenses", value: false }],
      };
    },
  };
}
