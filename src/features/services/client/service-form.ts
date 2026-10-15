// The service form, as the professional types it, and the commands sent to
// the existing Server Actions (src/features/services/actions/services.ts).
// The rules mirror src/features/services/schemas/service.ts and the CHECK
// constraints of public.services, which stay the authority: checking here
// only spares a round trip and words the message.

export type ServiceDraft = {
  name: string;
  description: string;
  /** Minutes, as typed. */
  duration: string;
  /** Major units as typed ("45", "45,50", "45.5"). */
  price: string;
};

export type ServiceField = keyof ServiceDraft;

/** What the list reads back (ServiceDto, serialisable). */
export type ServiceView = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  active: boolean;
  displayOrder: number;
  /** As last read: sent back as `expectedVersion` with an edit. */
  version: number;
};

export const EMPTY_SERVICE: ServiceDraft = {
  name: "",
  description: "",
  duration: "60",
  price: "",
};

export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 1000;
export const MIN_DURATION = 5;
export const MAX_DURATION = 720;
export const MAX_PRICE_CENTS = 10_000_000;

/**
 * Cents from a price typed in major units, without floating point: "45" →
 * 4500, "45,5" → 4550, "1 234,56" → 123456. Null when it is not a price
 * (more than two decimals, letters, negative…).
 */
export function parsePriceCents(text: string): number | null {
  const compact = text.replace(/[\s  €]/g, "").replace(",", ".");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(compact);
  if (!match) return null;
  const units = Number(match[1]);
  const decimals = Number((match[2] ?? "").padEnd(2, "0"));
  return units * 100 + decimals;
}

/** The price as a form shows it: "45", "45,50". */
export function priceInput(cents: number): string {
  const units = Math.trunc(cents / 100);
  const rest = cents % 100;
  return rest === 0
    ? String(units)
    : `${units},${String(rest).padStart(2, "0")}`;
}

/** "45 min", "1 h", "1 h 15". */
export function durationLabel(minutes: number): string {
  const hours = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0
    ? `${hours} h`
    : `${hours} h ${String(rest).padStart(2, "0")}`;
}

export function draftFromService(service: ServiceView): ServiceDraft {
  return {
    name: service.name,
    description: service.description ?? "",
    duration: String(service.durationMinutes),
    price: priceInput(service.priceCents),
  };
}

type Checked =
  | {
      ok: true;
      command: {
        name: string;
        description: string | null;
        durationMinutes: number;
        priceCents: number;
      };
    }
  | { ok: false; errors: Partial<Record<ServiceField, string>> };

/** The command for these values, or the field messages to show. */
export function checkService(draft: ServiceDraft): Checked {
  const errors: Partial<Record<ServiceField, string>> = {};
  const name = draft.name.trim();
  const description = draft.description.trim();
  const duration = /^\d+$/.test(draft.duration.trim())
    ? Number(draft.duration.trim())
    : NaN;
  const priceCents = parsePriceCents(draft.price);

  if (!name) errors.name = "Donne un nom à la prestation.";
  else if (name.length > MAX_NAME)
    errors.name = `Nom limité à ${MAX_NAME} caractères.`;
  if (description.length > MAX_DESCRIPTION)
    errors.description = `Description limitée à ${MAX_DESCRIPTION} caractères.`;
  if (!Number.isInteger(duration) || duration < MIN_DURATION)
    errors.duration = `Indique une durée en minutes (${MIN_DURATION} minimum).`;
  else if (duration > MAX_DURATION)
    errors.duration = `Durée limitée à ${MAX_DURATION / 60} heures.`;
  if (priceCents === null)
    errors.price = "Indique un prix, par exemple 45 ou 45,50.";
  else if (priceCents > MAX_PRICE_CENTS) errors.price = "Prix trop élevé.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    command: {
      name,
      description: description || null,
      durationMinutes: duration,
      priceCents: priceCents!,
    },
  };
}

/** Only what changed, as updateServiceAction expects it (`changes`). */
export function serviceChanges(
  service: ServiceView,
  command: Extract<Checked, { ok: true }>["command"],
) {
  const changes: Partial<typeof command> = {};
  if (command.name !== service.name) changes.name = command.name;
  if (command.description !== service.description)
    changes.description = command.description;
  if (command.durationMinutes !== service.durationMinutes)
    changes.durationMinutes = command.durationMinutes;
  if (command.priceCents !== service.priceCents)
    changes.priceCents = command.priceCents;
  return changes;
}

const serverFieldCopy: Record<string, ServiceField> = {
  name: "name",
  description: "description",
  durationMinutes: "duration",
  priceCents: "price",
  "changes.name": "name",
  "changes.description": "description",
  "changes.durationMinutes": "duration",
  "changes.priceCents": "price",
};

const serverMessages: Record<ServiceField, string> = {
  name: "Vérifie le nom (1 à 120 caractères).",
  description: "Description trop longue (1000 caractères au plus).",
  duration: "Durée entre 5 minutes et 12 heures.",
  price: "Vérifie le prix.",
};

/** Field messages of a refused write (the backend's text is never shown). */
export function serviceFieldErrors(fieldErrors?: Record<string, string[]>) {
  const errors: Partial<Record<ServiceField, string>> = {};
  for (const key of Object.keys(fieldErrors ?? {})) {
    const field = serverFieldCopy[key];
    if (field) errors[field] = serverMessages[field];
  }
  return errors;
}

const FIELDS: ServiceField[] = ["name", "description", "duration", "price"];

/** Whether two drafts would send the same values (as the backend reads them). */
function sameField(field: ServiceField, a: ServiceDraft, b: ServiceDraft) {
  const left = checkService(a);
  const right = checkService(b);
  if (left.ok && right.ok) {
    const key = {
      name: "name",
      description: "description",
      duration: "durationMinutes",
      price: "priceCents",
    }[field] as keyof typeof left.command;
    return left.command[key] === right.command[key];
  }
  return a[field].trim() === b[field].trim();
}

/**
 * Fields changed elsewhere since the draft's base was read: the value now,
 * the value typed, and whether the professional changed that field herself
 * (only then is it a real conflict). Same approach as the CRM record.
 */
export function serviceChangedElsewhere(
  base: ServiceView,
  current: ServiceView,
  draft: ServiceDraft,
) {
  const before = draftFromService(base);
  const now = draftFromService(current);
  return FIELDS.filter((field) => !sameField(field, before, now)).map(
    (field) => ({
      field,
      current: now[field],
      typed: draft[field],
      edited: !sameField(field, draft, before),
    }),
  );
}

/**
 * The draft moved onto the current service: what the professional changed
 * is kept, every other field takes its current value (a change made
 * elsewhere is never reverted by a field she did not touch).
 */
export function rebaseServiceDraft(
  base: ServiceView,
  current: ServiceView,
  draft: ServiceDraft,
): ServiceDraft {
  const before = draftFromService(base);
  const now = draftFromService(current);
  return Object.fromEntries(
    FIELDS.map((field) => [
      field,
      sameField(field, draft, before) ? now[field] : draft[field],
    ]),
  ) as ServiceDraft;
}

export const serviceFieldLabels: Record<ServiceField, string> = {
  name: "Nom",
  description: "Description",
  duration: "Durée (min)",
  price: "Prix",
};
