import type { FormFieldDto, FormFieldType } from "../contract";
import { checkTemplate } from "../engine";
import type { FormDraft } from "./contract";

// The draft's own rules, before anything is sent: a new question, a move,
// what blocks a removal, what blocks a publication. The server checks the
// same again when it publishes.

const shortId = (prefix: string) =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export const typeLabels: Record<FormFieldType, string> = {
  short_text: "Texte court",
  single_choice: "Choix unique",
  boolean: "Oui / non",
  attestation: "Attestation",
};

export function newField(type: FormFieldType): FormFieldDto {
  const base = { id: shortId("q"), type, label: "", required: true };
  if (type === "single_choice")
    return {
      ...base,
      options: [
        { id: shortId("o"), label: "" },
        { id: shortId("o"), label: "" },
      ],
    };
  if (type === "attestation") return { ...base, attestationText: "" };
  return base;
}

export const newOption = () => ({ id: shortId("o"), label: "" });

/** The list with one question moved by `delta` places (clamped). */
export function move<T>(items: T[], index: number, delta: number) {
  const to = Math.min(items.length - 1, Math.max(0, index + delta));
  if (to === index) return items;
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

/** The questions whose condition depends on this one. */
export function dependentsOf(fields: FormFieldDto[], id: string) {
  return fields.filter((field) => field.showIf?.field === id);
}

/** Everything that blocks a publication, by question ("_form": general). */
export function draftProblems(draft: FormDraft) {
  const problems: Record<string, string> = {};
  const say = (key: string, message: string) => {
    if (!(key in problems)) problems[key] = message;
  };
  if (!draft.title.trim()) say("_title", "Donne un titre au formulaire.");
  if (!draft.fields.length) say("_form", "Ajoute au moins une question.");
  if (
    draft.frequency.kind === "reuse_completed_for_days" &&
    !(
      Number.isInteger(draft.frequency.days) &&
      draft.frequency.days >= 1 &&
      draft.frequency.days <= 365
    )
  )
    say("_frequency", "Un nombre de jours entre 1 et 365.");
  for (const field of draft.fields) {
    if (!field.label.trim()) say(field.id, "Écris la question.");
    if (field.type === "single_choice") {
      const labels = (field.options ?? []).map((o) => o.label.trim());
      if (labels.some((label) => !label))
        say(field.id, "Chaque choix a besoin d’un libellé.");
      else if (new Set(labels).size !== labels.length)
        say(field.id, "Deux choix portent le même libellé.");
    }
  }
  for (const problem of checkTemplate(draft.fields))
    say(problem.fieldId, problem.message);
  return problems;
}

export const sameDraft = (a: FormDraft, b: FormDraft) =>
  JSON.stringify(a) === JSON.stringify(b);
