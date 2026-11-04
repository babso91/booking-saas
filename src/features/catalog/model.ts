// The catalogue as the product keeps it: her categories, her services and
// their options. Business data, never design data: no universe of the
// mini-site owns it, and changing universe never changes it. Same shapes as
// the Experience Engine lab (src/features/experience-lab/catalog/model.ts on
// proto/experience-engine), now backed by the database
// (supabase/migrations/20261103090000_service_catalog.sql).
//
// Nothing here names a trade: no category is required, none is built in.
//
// The server decides every price and duration (private.quote_options). The
// pure functions below only let a screen show the same result before
// asking; they never replace the server's answer.

export const catalogLimits = {
  categoryName: 60,
  serviceName: 120,
  description: 1000,
  question: 120,
  choiceLabel: 60,
  minDuration: 5,
  /** A service with its longest answers never lasts more than this. */
  maxDuration: 720,
  maxDurationDelta: 240,
  maxPriceDeltaCents: 9_999_999,
  maxOptions: 20,
  maxChoices: 20,
} as const;

export type OptionChoice = {
  id: string;
  label: string;
  /** Added to the service's price (cents, ≥ 0). */
  priceDeltaCents: number;
  /** Added to its duration: 0 unless she sets it, never assumed. */
  durationDeltaMinutes: number;
};

/**
 * A group of answers asked when booking; one answer per group (V1).
 * required: an answer must be given. Optional: no answer adds nothing (an
 * explicit "Aucun supplément" answer is hers to add if she wants one).
 */
export type ServiceOption = {
  id: string;
  question: string;
  required: boolean;
  choices: OptionChoice[];
};

/** A service of the public catalogue (bookable online). */
export type PublicCatalogService = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  options: ServiceOption[];
};

/** A group of the public catalogue: a visible category, or none (last). */
export type PublicCatalogGroup = {
  category: { id: string; name: string } | null;
  services: PublicCatalogService[];
};

export type PublicCatalog = {
  currency: string;
  groups: PublicCatalogGroup[];
};

/** Why a set of answers is refused (the server's codes). */
export type QuoteRefusal =
  "invalid_options" | "option_choice_unavailable" | "options_required";

export type Quote =
  | { ok: true; priceCents: number; durationMinutes: number }
  | { ok: false; reason: QuoteRefusal };

/**
 * What the server would book for these answers: the same rule as
 * private.quote_options (answers of this service only, one per group, every
 * required group answered). For display; the booking is priced again by
 * the server.
 */
export function quote(
  service: Pick<
    PublicCatalogService,
    "priceCents" | "durationMinutes" | "options"
  >,
  choiceIds: readonly string[],
): Quote {
  if (choiceIds.length > 50 || new Set(choiceIds).size !== choiceIds.length) {
    return { ok: false, reason: "invalid_options" };
  }
  const chosen = new Map<string, OptionChoice>();
  for (const id of choiceIds) {
    const option = service.options.find((item) =>
      item.choices.some((choice) => choice.id === id),
    );
    if (!option) return { ok: false, reason: "option_choice_unavailable" };
    if (chosen.has(option.id)) return { ok: false, reason: "invalid_options" };
    chosen.set(
      option.id,
      option.choices.find((choice) => choice.id === id)!,
    );
  }
  if (
    service.options.some((option) => option.required && !chosen.has(option.id))
  ) {
    return { ok: false, reason: "options_required" };
  }
  let priceCents = service.priceCents;
  let durationMinutes = service.durationMinutes;
  for (const choice of chosen.values()) {
    priceCents += choice.priceDeltaCents;
    durationMinutes += choice.durationDeltaMinutes;
  }
  return { ok: true, priceCents, durationMinutes };
}

/** The answers chosen for an appointment, as they were when it was booked. */
export type OptionSnapshot = {
  optionId: string;
  question: string;
  choiceId: string;
  label: string;
  priceDeltaCents: number;
  durationDeltaMinutes: number;
};
