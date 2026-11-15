import { sampleFields } from "../memory-actions";
import {
  editorErrors,
  type EditorResult,
  type FormEditorActions,
  type FormTemplateDto,
} from "./contract";
import { draftProblems } from "./draft";

// An in-memory server of the PROPOSED template contract, for the preview
// and the tests only: the draft's lock, a replayed request id, a published
// version frozen.

const fail = (code: string): EditorResult<never> => ({
  ok: false,
  error: { code },
});

export function sampleTemplate(): FormTemplateDto {
  return {
    templateId: "ft-lift",
    status: "active",
    draftVersion: 4,
    draft: {
      title: "Préparer votre rehaussement de cils",
      intro:
        "Quelques questions pour préparer votre venue. Seule votre praticienne lit vos réponses.",
      review: "professional",
      frequency: { kind: "reuse_completed_for_days", days: 90 },
      fields: structuredClone(sampleFields),
    },
    published: [
      {
        versionId: "tv-3",
        number: 3,
        publishedAt: "2026-11-02T10:00:00.000Z",
      },
    ],
  };
}

export function memoryFormEditor(
  start: FormTemplateDto = sampleTemplate(),
  options: { delayMs?: number } = {},
) {
  let template = structuredClone(start);
  const answered = new Map<string, EditorResult<FormTemplateDto>>();
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  async function once(
    requestId: string,
    run: () => EditorResult<FormTemplateDto>,
  ) {
    await pause();
    const earlier = answered.get(requestId);
    if (earlier) return earlier;
    const result = run();
    if (result.ok) answered.set(requestId, result);
    return result;
  }

  const actions: FormEditorActions = {
    async read(templateId) {
      await pause();
      if (templateId !== template.templateId) return fail("not_found");
      return { ok: true, data: structuredClone(template) };
    },
    saveDraft: (input) =>
      once(input.requestId, () => {
        if (input.expectedDraftVersion !== template.draftVersion)
          return fail(editorErrors.versionConflict);
        template = {
          ...template,
          draftVersion: template.draftVersion + 1,
          draft: structuredClone(input.draft),
        };
        return { ok: true, data: structuredClone(template) };
      }),
    publish: (input) =>
      once(input.requestId, () => {
        if (input.expectedDraftVersion !== template.draftVersion)
          return fail(editorErrors.versionConflict);
        if (Object.keys(draftProblems(template.draft)).length)
          return fail(editorErrors.invalidTemplate);
        const number = (template.published[0]?.number ?? 0) + 1;
        template = {
          ...template,
          status: "active",
          draftVersion: template.draftVersion + 1,
          published: [
            {
              versionId: `tv-${number}`,
              number,
              publishedAt: new Date().toISOString(),
            },
            ...template.published,
          ],
        };
        return { ok: true, data: structuredClone(template) };
      }),
  };
  return {
    actions,
    get template() {
      return template;
    },
    /** Someone else saves the draft (tests and preview only). */
    touch(change: (t: FormTemplateDto) => FormTemplateDto) {
      template = change(template);
    },
  };
}
