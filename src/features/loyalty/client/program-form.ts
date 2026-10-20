import type { LoyaltyAccrualMode, LoyaltyProgramDto } from "../types";

// The program form, as the professional types it, and the command sent to
// configureLoyaltyProgramAction. PostgreSQL stays the authority on bounds
// (docs/LOYALTY_CONTRACT.md); checking here only spares a round trip and
// words the message. A value written before today's bounds is sent back
// exactly as read when the professional did not touch it, so the backend
// keeps it (it refuses only a *new* out-of-bounds value).

export type ProgramDraft = {
  accrualMode: LoyaltyAccrualMode;
  /** Points per completed appointment, as typed. */
  perAppointment: string;
  /** Points per euro, as typed ("1,5" or "1.5"). */
  perEuro: string;
};

export type ProgramField = "perAppointment" | "perEuro";

export const POINTS_PER_APPOINTMENT_MAX = 10_000;
export const PER_EURO_MIN = "0.01";
export const PER_EURO_MAX = "100";

export function programDraft(program: LoyaltyProgramDto): ProgramDraft {
  return {
    accrualMode: program.accrualMode,
    perAppointment: String(program.pointsPerCompletedAppointment),
    perEuro: program.pointsPerEuro ? decimalInput(program.pointsPerEuro) : "",
  };
}

/** "1.5" → "1,5" (French input), digits untouched. */
export function decimalInput(value: string) {
  return value.replace(".", ",");
}

/**
 * A rate typed in French or English notation, as the exact decimal string
 * the contract expects ("1,5" → "1.5"), or null when it is not a positive
 * decimal with at most 4 decimals. No floating point anywhere.
 */
export function parseRate(text: string): string | null {
  const compact = text.replace(/\s/g, "").replace(",", ".");
  const match = /^(\d{1,6})(?:\.(\d{1,4}))?$/.exec(compact);
  if (!match) return null;
  const units = match[1]!.replace(/^0+(?=\d)/, "");
  const decimals = (match[2] ?? "").replace(/0+$/, "");
  const value = decimals ? `${units}.${decimals}` : units;
  return /[1-9]/.test(value) ? value : null;
}

/** Ten-thousandths of a rate string ("1.5" → 15000n), exact. */
export function rateUnits(rate: string): bigint {
  const [units, decimals = ""] = rate.split(".");
  return BigInt(units!) * 10_000n + BigInt(decimals.padEnd(4, "0") || "0");
}

/**
 * Points a price would earn in spend mode: floor(cents × rate / 100), as
 * PostgreSQL computes it in NUMERIC. Only a preview at today's price: the
 * price recorded on the appointment decides.
 */
export function spendPoints(priceCents: number, rate: string): number {
  return Number((BigInt(priceCents) * rateUnits(rate)) / 1_000_000n);
}

const inRateBounds = (rate: string) =>
  rateUnits(rate) >= rateUnits(PER_EURO_MIN) &&
  rateUnits(rate) <= rateUnits(PER_EURO_MAX);

export type ProgramCheck =
  | {
      ok: true;
      pointsPerCompletedAppointment: number;
      pointsPerEuro: string | null;
    }
  | { ok: false; errors: Partial<Record<ProgramField, string>> };

/** Checks the draft against the program as read (`base`). */
export function checkProgram(
  draft: ProgramDraft,
  base: LoyaltyProgramDto,
): ProgramCheck {
  const errors: Partial<Record<ProgramField, string>> = {};

  let perAppointment = base.pointsPerCompletedAppointment;
  if (draft.perAppointment.trim() !== String(perAppointment)) {
    const typed = draft.perAppointment.trim();
    const value = /^\d{1,9}$/.test(typed) ? Number(typed) : null;
    if (value === null || value < 1 || value > POINTS_PER_APPOINTMENT_MAX) {
      errors.perAppointment = `Indique un nombre entier de 1 à ${POINTS_PER_APPOINTMENT_MAX.toLocaleString("fr-FR")}.`;
    } else {
      perAppointment = value;
    }
  }

  let perEuro: string | null = null;
  if (draft.accrualMode === "spend") {
    const typed = parseRate(draft.perEuro);
    if (typed === null) {
      errors.perEuro = draft.perEuro.trim()
        ? "Indique un nombre positif, 4 décimales au plus (ex. 1 ou 0,5)."
        : "Indique combien de points rapporte 1 €.";
    } else if (typed === base.pointsPerEuro) {
      perEuro = base.pointsPerEuro; // as read, even outside today's bounds
    } else if (!inRateBounds(typed)) {
      errors.perEuro = "Entre 0,01 et 100 points par euro.";
    } else {
      perEuro = typed;
    }
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        pointsPerCompletedAppointment: perAppointment,
        pointsPerEuro: perEuro,
      };
}

/** Whether the draft differs from the program as read. */
export function programDirty(draft: ProgramDraft, base: LoyaltyProgramDto) {
  const initial = programDraft(base);
  if (draft.accrualMode !== initial.accrualMode) return true;
  if (draft.perAppointment.trim() !== initial.perAppointment) return true;
  if (draft.accrualMode === "spend") {
    const typed = parseRate(draft.perEuro);
    return typed === null || typed !== base.pointsPerEuro;
  }
  return false;
}

/** The whole configuration for configureLoyaltyProgramAction. */
export function programCommand(
  base: LoyaltyProgramDto,
  values: { active: boolean; accrualMode: LoyaltyAccrualMode },
  checked: Extract<ProgramCheck, { ok: true }>,
) {
  return {
    expectedVersion: base.version,
    active: values.active,
    accrualMode: values.accrualMode,
    pointsPerCompletedAppointment: checked.pointsPerCompletedAppointment,
    pointsPerEuro:
      values.accrualMode === "spend" ? checked.pointsPerEuro : null,
  };
}

/** The saved configuration with another activation state. */
export function activationCommand(base: LoyaltyProgramDto, active: boolean) {
  return {
    expectedVersion: base.version,
    active,
    accrualMode: base.accrualMode,
    pointsPerCompletedAppointment: base.pointsPerCompletedAppointment,
    pointsPerEuro: base.accrualMode === "spend" ? base.pointsPerEuro : null,
  };
}

/** One sentence: what a completed appointment earns. */
export function earningSummary(program: {
  accrualMode: LoyaltyAccrualMode;
  pointsPerCompletedAppointment: number;
  pointsPerEuro: string | null;
}) {
  if (program.accrualMode === "spend") {
    return program.pointsPerEuro
      ? `${decimalInput(program.pointsPerEuro)} point${rateUnits(program.pointsPerEuro) >= 20_000n ? "s" : ""} par euro dépensé, arrondi à l’entier inférieur`
      : "Points au montant dépensé";
  }
  const points = program.pointsPerCompletedAppointment;
  return `${points.toLocaleString("fr-FR")} point${points > 1 ? "s" : ""} par rendez-vous terminé`;
}
