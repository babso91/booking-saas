import { catalogLimits, type ServiceOption } from "@/features/catalog/model";
import type { SetServiceOptionsInput } from "@/features/catalog/schemas";
import {
  parsePriceCents,
  priceInput,
} from "@/features/services/client/service-form";

// The options of one service while she edits them (docs/CATALOG_CONTRACT.md):
// groups of answers asked when booking, each answer adding a price and a
// duration. A draft is text as typed; the command sent is the complete list
// in her order, with every existing group or answer she removed named
// explicitly (the server deletes nothing by omission). Prices and durations
// booked are always the server's: nothing is totalled here.

export type ChoiceDraft = {
  /** Stable in the form; never sent. */
  key: string;
  /** The saved answer it edits; null: a new one. */
  id: string | null;
  label: string;
  /** As typed, in major units ("15", "7,50"); empty: nothing added. */
  price: string;
  /** As typed, in minutes; empty: nothing added. */
  minutes: string;
};

export type OptionDraft = {
  key: string;
  id: string | null;
  question: string;
  required: boolean;
  choices: ChoiceDraft[];
};

let keys = 0;
const nextKey = () => `k${(keys += 1)}`;

export const emptyChoice = (): ChoiceDraft => ({
  key: nextKey(),
  id: null,
  label: "",
  price: "",
  minutes: "",
});

/** A new group starts with one answer to fill in. */
export const emptyOption = (): OptionDraft => ({
  key: nextKey(),
  id: null,
  question: "",
  required: true,
  choices: [emptyChoice()],
});

export function draftOf(options: ServiceOption[]): OptionDraft[] {
  return options.map((option) => ({
    key: nextKey(),
    id: option.id,
    question: option.question,
    required: option.required,
    choices: option.choices.map((choice) => ({
      key: nextKey(),
      id: choice.id,
      label: choice.label,
      price: choice.priceDeltaCents ? priceInput(choice.priceDeltaCents) : "",
      minutes: choice.durationDeltaMinutes
        ? String(choice.durationDeltaMinutes)
        : "",
    })),
  }));
}

/** Cents added by an answer; null when what is typed is not a price. */
export function priceOf(text: string): number | null {
  if (text.trim() === "") return 0;
  const cents = parsePriceCents(text);
  return cents === null || cents > catalogLimits.maxPriceDeltaCents
    ? null
    : cents;
}

/** Minutes added by an answer; null when what is typed is not a duration. */
export function minutesOf(text: string): number | null {
  const compact = text.trim();
  if (compact === "") return 0;
  if (!/^\d{1,3}$/.test(compact)) return null;
  const minutes = Number(compact);
  return minutes > catalogLimits.maxDurationDelta ? null : minutes;
}

/** Errors by field key: `<group key>` (question), `<choice key>:label|price|minutes`. */
export type OptionErrors = Record<string, string>;

export function checkOptions(draft: OptionDraft[]): OptionErrors {
  const errors: OptionErrors = {};
  for (const option of draft) {
    const question = option.question.trim();
    if (!question) errors[option.key] = "Écris la question posée à ta cliente.";
    else if (question.length > catalogLimits.question)
      errors[option.key] =
        `${catalogLimits.question} caractères au plus pour la question.`;
    const seen = new Set<string>();
    for (const choice of option.choices) {
      const label = choice.label.trim();
      const same = label.toLocaleLowerCase("fr");
      if (!label) errors[`${choice.key}:label`] = "Nomme cette réponse.";
      else if (label.length > catalogLimits.choiceLabel)
        errors[`${choice.key}:label`] =
          `${catalogLimits.choiceLabel} caractères au plus.`;
      else if (seen.has(same))
        errors[`${choice.key}:label`] = "Cette réponse existe déjà.";
      seen.add(same);
      if (priceOf(choice.price) === null)
        errors[`${choice.key}:price`] = "Un montant, par exemple 15 ou 7,50.";
      if (minutesOf(choice.minutes) === null)
        errors[`${choice.key}:minutes`] =
          `Des minutes entières, ${catalogLimits.maxDurationDelta} au plus.`;
    }
  }
  return errors;
}

/** The complete command for a draft without errors (checkOptions first). */
export function commandOf(
  serviceId: string,
  expectedVersion: number,
  saved: ServiceOption[],
  draft: OptionDraft[],
): SetServiceOptionsInput {
  const keptOptions = new Set(draft.map((option) => option.id));
  const keptChoices = new Set(
    draft.flatMap((option) => option.choices.map((choice) => choice.id)),
  );
  const deletedOptionIds = saved
    .filter((option) => !keptOptions.has(option.id))
    .map((option) => option.id);
  return {
    serviceId,
    expectedVersion,
    options: draft.map((option) => ({
      id: option.id,
      question: option.question.trim(),
      required: option.required,
      choices: option.choices.map((choice) => ({
        id: choice.id,
        label: choice.label.trim(),
        priceDeltaCents: priceOf(choice.price) ?? 0,
        durationDeltaMinutes: minutesOf(choice.minutes) ?? 0,
      })),
    })),
    deletedOptionIds,
    // An answer of a deleted group goes with its group: named only when
    // its group stays.
    deletedChoiceIds: saved
      .filter((option) => keptOptions.has(option.id))
      .flatMap((option) => option.choices)
      .filter((choice) => !keptChoices.has(choice.id))
      .map((choice) => choice.id),
  };
}

/** What is saved, in the draft's own shape (to compare, without keys). */
const shapeOf = (draft: OptionDraft[]) =>
  JSON.stringify(
    draft.map((option) => [
      option.id,
      option.question.trim(),
      option.required,
      option.choices.map((choice) => [
        choice.id,
        choice.label.trim(),
        priceOf(choice.price),
        minutesOf(choice.minutes),
      ]),
    ]),
  );

/** Whether her draft differs from what is saved. */
export const optionsChanged = (saved: ServiceOption[], draft: OptionDraft[]) =>
  shapeOf(draftOf(saved)) !== shapeOf(draft);

/** A group, moved one step. */
export function moved<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
