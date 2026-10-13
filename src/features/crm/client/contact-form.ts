import type { UiError } from "@/features/auth/client/call-action";
import type { ClientRecordDto } from "@/features/crm/types";

// The customer form (creation and edition): what is typed, the command sent,
// and the screen copy of its errors. The rules are those of the backend
// (src/features/crm/schemas/contact.ts), which stays the authority: checking
// here only spares a round trip and words the message.

export type ContactField = "firstName" | "lastName" | "email" | "phone";

export const CONTACT_FIELDS: readonly ContactField[] = [
  "firstName",
  "lastName",
  "email",
  "phone",
];

/** What the professional typed, as typed. */
export type ContactDraft = Record<ContactField, string>;

export const EMPTY_CONTACT: ContactDraft = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
};

export const contactLabels: Record<ContactField, string> = {
  firstName: "Prénom",
  lastName: "Nom",
  email: "Email",
  phone: "Téléphone",
};

/** The record's current values, as a form shows them. */
export function draftFromRecord(record: ClientRecordDto): ContactDraft {
  return {
    firstName: record.firstName,
    lastName: record.lastName ?? "",
    email: record.email ?? "",
    phone: record.phone ?? "",
  };
}

/** The command for these values: normalized as the backend does it. */
export function contactCommand(draft: ContactDraft) {
  const text = (value: string) => value.normalize("NFC").trim();
  return {
    firstName: text(draft.firstName),
    lastName: text(draft.lastName) || null,
    email: draft.email.trim().toLowerCase() || null,
    phone: draft.phone.trim() || null,
  };
}

export type ContactCommand = ReturnType<typeof contactCommand>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]{6,30}$/;

/** Field messages before sending; empty when the backend may accept it. */
export function checkContact(
  draft: ContactDraft,
): Partial<Record<ContactField, string>> {
  const command = contactCommand(draft);
  const errors: Partial<Record<ContactField, string>> = {};
  if (!command.firstName) errors.firstName = "Indique au moins le prénom.";
  else if (command.firstName.length > 120)
    errors.firstName = "Prénom trop long (120 caractères au plus).";
  if ((command.lastName?.length ?? 0) > 120)
    errors.lastName = "Nom trop long (120 caractères au plus).";
  if (
    command.email &&
    (command.email.length > 254 || !EMAIL.test(command.email))
  )
    errors.email = "Cet email semble invalide.";
  if (command.phone && !PHONE.test(command.phone))
    errors.phone =
      "Ce numéro semble invalide (chiffres, espaces, + . - et parenthèses).";
  return errors;
}

const serverFieldCopy: Record<ContactField, string> = {
  firstName: "Indique un prénom de 120 caractères au plus.",
  lastName: "Nom trop long (120 caractères au plus).",
  email: "Cet email semble invalide.",
  phone: "Ce numéro semble invalide.",
};

/** Field messages of a refused write (the backend's text is never shown). */
export function contactFieldErrors(
  error: UiError,
): Partial<Record<ContactField, string>> {
  const errors: Partial<Record<ContactField, string>> = {};
  for (const key of Object.keys(error.fieldErrors ?? {})) {
    if ((CONTACT_FIELDS as readonly string[]).includes(key)) {
      const field = key as ContactField;
      errors[field] =
        error.code === "client_email_conflict" && field === "email"
          ? "Cet email est déjà celui d’une autre cliente."
          : serverFieldCopy[field];
    }
  }
  return errors;
}

/** Whether two drafts would send the same command. */
export function sameContact(a: ContactDraft, b: ContactDraft) {
  const left = contactCommand(a);
  const right = contactCommand(b);
  return CONTACT_FIELDS.every((field) => left[field] === right[field]);
}

/** Whether a field holds the same value (as the backend would store it). */
const sameField = (field: ContactField, a: ContactDraft, b: ContactDraft) =>
  contactCommand(a)[field] === contactCommand(b)[field];

/**
 * Fields where the record changed elsewhere while a draft was being typed:
 * what the record holds now, what was typed, and whether the professional
 * had changed that field herself (only then is it a real conflict).
 */
export function changedElsewhere(
  base: ClientRecordDto,
  current: ClientRecordDto,
  draft: ContactDraft,
) {
  const before = draftFromRecord(base);
  const now = draftFromRecord(current);
  return CONTACT_FIELDS.filter((field) => !sameField(field, before, now)).map(
    (field) => ({
      field,
      current: now[field],
      typed: draft[field],
      edited: !sameField(field, draft, before),
    }),
  );
}

/**
 * The draft moved onto the current record: what the professional changed
 * is kept, every other field takes its current value (a change made
 * elsewhere is never reverted by a field she did not touch).
 */
export function rebaseDraft(
  base: ClientRecordDto,
  current: ClientRecordDto,
  draft: ContactDraft,
): ContactDraft {
  const before = draftFromRecord(base);
  const now = draftFromRecord(current);
  return Object.fromEntries(
    CONTACT_FIELDS.map((field) => [
      field,
      sameField(field, draft, before) ? now[field] : draft[field],
    ]),
  ) as ContactDraft;
}

/** Moves the keyboard to the first field in error (fields in form order). */
export function focusFirstError(
  form: HTMLFormElement | null,
  errors: Partial<Record<ContactField, string>>,
) {
  const index = CONTACT_FIELDS.findIndex((field) => errors[field]);
  if (index < 0 || !form) return;
  form.querySelectorAll<HTMLInputElement>("input")[index]?.focus();
}
