import type { UiResult } from "@/features/auth/client/call-action";

import {
  visitNoteErrors,
  type FieldDefinitionDto,
  type TechnicalNoteDto,
  type VisitNotesActions,
  type VisitPreparationDto,
} from "./contract";

// An in-memory server of the PROPOSED visit-notes contract, for the design
// preview and the tests only: it keeps versions, refuses stale writes and
// replays a request id, as the contract asks of the real one. Nothing here
// reaches a database; never used by a real page.

const fail = (code: string): UiResult<never> =>
  ({ ok: false, error: { code } }) as unknown as UiResult<never>;

export const sampleFields: FieldDefinitionDto[] = [
  {
    id: "f-length",
    label: "Longueur",
    kind: "number",
    unit: "mm",
    choices: [],
  },
  {
    id: "f-curl",
    label: "Courbure",
    kind: "choice",
    unit: null,
    choices: ["C", "CC", "D"],
  },
  {
    id: "f-notes",
    label: "Observations",
    kind: "text",
    unit: null,
    choices: [],
  },
];

export function samplePreparation(
  over: Partial<VisitPreparationDto> = {},
): VisitPreparationDto {
  return {
    appointmentId: "a-visit",
    clientId: "c-lea",
    clientName: "Léa Fontaine",
    serviceName: "Pose volume",
    startsAt: "2026-11-18T13:00:00.000Z",
    timezone: "Europe/Paris",
    preferences: {
      version: 2,
      text: "Yeux sensibles : colle douce. Préfère un rendu naturel.",
    },
    lastRecord: {
      id: "n-earlier",
      version: 3,
      state: "recorded",
      serviceName: "Pose volume",
      visitStartsAt: "2026-10-14T13:00:00.000Z",
      fieldValues: [
        { fieldId: "f-length", label: "Longueur", value: "11", unit: "mm" },
        { fieldId: "f-curl", label: "Courbure", value: "CC", unit: null },
        { fieldId: "f-old", label: "Épaisseur", value: "0,07", unit: "mm" },
      ],
      products: [{ name: "Colle sensitive", quantity: "1", unit: "goutte" }],
      recordedAt: "2026-10-14T14:40:00.000Z",
      supersedesId: null,
      correctionReason: null,
    },
    current: null,
    allowedFields: sampleFields,
    tags: [
      { id: "t-sensitive", label: "Yeux sensibles", archived: false },
      { id: "t-regular", label: "Fidèle", archived: false },
      { id: "t-old", label: "Ancienne offre", archived: true },
    ],
    clientTagIds: ["t-sensitive", "t-old"],
    ...over,
  };
}

export function memoryVisitNotes(
  start: VisitPreparationDto = samplePreparation(),
  options: { delayMs?: number } = {},
) {
  const state = structuredClone(start);
  const answered = new Map<string, UiResult<unknown>>();
  let ids = 0;
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  /** Answers a request id once: the same id gives the same answer. */
  async function once<T>(
    requestId: string,
    run: () => UiResult<T>,
  ): Promise<UiResult<T>> {
    await pause();
    const earlier = answered.get(requestId);
    if (earlier) return earlier as UiResult<T>;
    const result = run();
    if (result.ok) answered.set(requestId, result);
    return result;
  }
  const labelled = (values: { fieldId: string; value: string }[]) => {
    const fields = new Map(
      state.allowedFields.map((field) => [field.id, field]),
    );
    if (values.some((value) => !fields.has(value.fieldId))) return null;
    return values.map((value) => ({
      fieldId: value.fieldId,
      label: fields.get(value.fieldId)!.label,
      value: value.value,
      unit: fields.get(value.fieldId)!.unit,
    }));
  };

  const actions: VisitNotesActions = {
    async preparation() {
      await pause();
      return { ok: true, data: structuredClone(state) };
    },
    saveDraft: (input) =>
      once(input.requestId, () => {
        const current = state.current;
        const draft = current?.state === "draft" ? current : null;
        if ((draft?.version ?? 0) !== input.expectedVersion)
          return fail(visitNoteErrors.stale);
        const fieldValues = labelled(input.fieldValues);
        if (!fieldValues) return fail(visitNoteErrors.fieldNotAllowed);
        const saved: TechnicalNoteDto = {
          id: draft?.id ?? `n-${(ids += 1)}`,
          version: (draft?.version ?? 0) + 1,
          state: "draft",
          serviceName: state.serviceName,
          fieldValues,
          products: input.products,
          recordedAt: null,
          supersedesId:
            draft?.supersedesId ??
            input.supersedesId ??
            (current?.state === "recorded" ? current.id : null),
          correctionReason: null,
        };
        state.current = saved;
        return { ok: true, data: structuredClone(saved) };
      }),
    record: (input) =>
      once(input.requestId, () => {
        const draft = state.current;
        if (
          !draft ||
          draft.id !== input.noteId ||
          draft.state !== "draft" ||
          draft.version !== input.expectedVersion
        )
          return fail(visitNoteErrors.stale);
        if (draft.supersedesId && !input.correctionReason?.trim())
          return fail("validation_error");
        const recorded: TechnicalNoteDto = {
          ...draft,
          version: draft.version + 1,
          state: "recorded",
          recordedAt: new Date().toISOString(),
          correctionReason: input.correctionReason?.trim() || null,
        };
        state.current = recorded;
        return { ok: true, data: structuredClone(recorded) };
      }),
    setTag: (input) =>
      once(input.requestId, () => {
        const tag = state.tags.find((item) => item.id === input.tagId);
        if (!tag || (tag.archived && input.attached)) return fail("not_found");
        const without = state.clientTagIds.filter((id) => id !== input.tagId);
        state.clientTagIds = input.attached
          ? [...without, input.tagId]
          : without;
        return {
          ok: true,
          data: { clientId: state.clientId, tagIds: [...state.clientTagIds] },
        };
      }),
  };

  return {
    actions,
    /** The server's state, to assert on or to change "elsewhere". */
    state,
  };
}
