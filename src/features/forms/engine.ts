import type { Answers, FormFieldDto } from "./contract";

// The form's own rules, the same on both sides: which questions are shown,
// which answers count, what is missing. The server recomputes all of it;
// the screen only uses it to show the right questions and say what is
// missing before sending.

/**
 * A template the engine accepts: unique ids, a condition always on an
 * EARLIER field (so no cycle can exist), choices for a choice, a text for
 * an attestation. Returns what is wrong, empty when it is valid.
 */
export type TemplateProblem = { fieldId: string; message: string };

export function checkTemplate(fields: FormFieldDto[]): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const seen = new Map<string, FormFieldDto>();
  const say = (fieldId: string, message: string) =>
    problems.push({ fieldId, message });
  for (const field of fields) {
    if (seen.has(field.id)) say(field.id, "Identifiant en double.");
    if (field.showIf) {
      const target = seen.get(field.showIf.field);
      if (!target)
        say(
          field.id,
          "La condition doit porter sur une question placée avant celle-ci.",
        );
      else if (
        target.type === "single_choice" &&
        !target.options?.some((option) => option.id === field.showIf!.equals)
      )
        say(field.id, "La condition porte sur un choix qui n’existe plus.");
      else if (
        (target.type === "boolean") !==
          (typeof field.showIf.equals === "boolean") ||
        target.type === "short_text" ||
        target.type === "attestation"
      )
        say(field.id, "La condition ne correspond pas à cette question.");
    }
    if (field.type === "single_choice" && !field.options?.length)
      say(field.id, "Ajoute au moins un choix.");
    if (field.type === "attestation" && !field.attestationText?.trim())
      say(field.id, "Écris le texte à confirmer.");
    seen.set(field.id, field);
  }
  return problems;
}

/** The questions shown for these answers, in order. */
export function visibleFields(fields: FormFieldDto[], answers: Answers) {
  const shown = new Set<string>();
  return fields.filter((field) => {
    const condition = field.showIf;
    const visible =
      !condition ||
      (shown.has(condition.field) &&
        answers[condition.field] === condition.equals);
    if (visible) shown.add(field.id);
    return visible;
  });
}

/** Only the answers of shown questions: a hidden answer is never kept. */
export function pruneHidden(fields: FormFieldDto[], answers: Answers) {
  const kept: Answers = {};
  for (const field of visibleFields(fields, answers))
    if (field.id in answers) kept[field.id] = answers[field.id]!;
  return kept;
}

const answered = (field: FormFieldDto, value: unknown) =>
  field.type === "attestation"
    ? value === true
    : field.type === "boolean"
      ? typeof value === "boolean"
      : typeof value === "string" && value.trim() !== "";

/** What is missing among the shown questions, by field id. */
export function missingAnswers(fields: FormFieldDto[], answers: Answers) {
  const errors: Record<string, string> = {};
  for (const field of visibleFields(fields, answers)) {
    if (!field.required || answered(field, answers[field.id])) continue;
    errors[field.id] =
      field.type === "attestation"
        ? "Merci de confirmer pour continuer."
        : field.type === "short_text"
          ? "Merci de répondre à cette question."
          : "Merci de choisir une réponse.";
  }
  return errors;
}

/** Shown required questions answered, of all shown required ones. */
export function progressOf(fields: FormFieldDto[], answers: Answers) {
  const required = visibleFields(fields, answers).filter((f) => f.required);
  return {
    done: required.filter((field) => answered(field, answers[field.id])).length,
    total: required.length,
  };
}

/** Answers that still fit a newer version: same id, a value it accepts. */
export function carryOver(fields: FormFieldDto[], answers: Answers) {
  const kept: Answers = {};
  for (const field of fields) {
    const value = answers[field.id];
    if (value === undefined) continue;
    if (field.type === "attestation") continue; // a new text, a new confirmation
    if (field.type === "boolean" && typeof value === "boolean")
      kept[field.id] = value;
    if (field.type === "short_text" && typeof value === "string")
      kept[field.id] = value;
    if (
      field.type === "single_choice" &&
      field.options?.some((option) => option.id === value)
    )
      kept[field.id] = value;
  }
  return pruneHidden(fields, kept);
}
