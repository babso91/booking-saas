import { formatPrice } from "@/features/agenda/client/money";

import type {
  LoyaltyLedgerEntryDto,
  RedemptionStatus,
  RewardEligibilityDto,
  RewardType,
} from "../types";

// Words and numbers of the loyalty screens.

/** "120 points", "1 point", "−10 points" (a real minus sign). */
export function points(value: number) {
  const size = Math.abs(value);
  return `${value < 0 ? "−" : ""}${size.toLocaleString("fr-FR")} point${size > 1 ? "s" : ""}`;
}

/** "+10 points", "−100 points". */
export function pointsDelta(value: number) {
  return `${value < 0 ? "−" : "+"}${points(Math.abs(value))}`;
}

/** What the reward gives: "5,00 € de remise", "10 % de remise", "Pose cil à cil offerte". */
export function rewardValueLabel(reward: {
  rewardType: RewardType;
  rewardValue: number | null;
  currency: string | null;
  serviceName?: string | null;
}) {
  switch (reward.rewardType) {
    case "fixed_discount":
      return reward.rewardValue === null
        ? "Remise (montant à préciser)"
        : `${formatPrice(reward.rewardValue, reward.currency ?? "EUR")} de remise`;
    case "percentage_discount":
      return reward.rewardValue === null
        ? "Remise (pourcentage à préciser)"
        : `${reward.rewardValue} % de remise`;
    case "free_service":
      return reward.serviceName
        ? `${reward.serviceName} offerte`
        : "Prestation offerte";
  }
}

export const unavailableCopy: Record<
  NonNullable<RewardEligibilityDto["unavailableReason"]>,
  string
> = {
  program_inactive: "Programme en pause",
  inactive: "Récompense désactivée",
  service_missing: "Prestation offerte supprimée",
  currency_missing: "Devise manquante",
};

export const redemptionStatusLabels: Record<RedemptionStatus, string> = {
  issued: "À utiliser",
  fulfilled: "Utilisée",
  cancelled: "Annulée",
};

const entryTitles: Record<LoyaltyLedgerEntryDto["type"], string> = {
  appointment_completed: "Rendez-vous terminé",
  manual_adjustment: "Ajustement manuel",
  reward_redeemed: "Récompense attribuée",
  correction: "Correction",
};

export function entryTitle(entry: LoyaltyLedgerEntryDto) {
  if (entry.type === "reward_redeemed" && entry.redemption)
    return `Récompense attribuée : ${entry.redemption.rewardName}`;
  if (entry.type === "correction" && entry.redemption)
    return `Récompense annulée : ${entry.redemption.rewardName}`;
  if (
    entry.type === "appointment_completed" &&
    (entry.awardGeneration ?? 1) > 1
  )
    return "Rendez-vous terminé à nouveau";
  return entryTitles[entry.type];
}

/** The four groups of the history filter. */
export type EntryGroup = "earned" | "spent" | "corrections";

export function entryGroup(entry: LoyaltyLedgerEntryDto): EntryGroup {
  if (entry.type === "appointment_completed") return "earned";
  if (entry.type === "reward_redeemed") return "spent";
  if (entry.type === "manual_adjustment")
    return entry.pointsDelta > 0 ? "earned" : "spent";
  return "corrections";
}

/** A manual adjustment that has not been compensated yet. */
export const isReversible = (entry: LoyaltyLedgerEntryDto) =>
  entry.type === "manual_adjustment" && entry.reversedByEntryId === null;

const instantFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * "12 oct. 2026, 14:30" in the business time zone. Loyalty instants come
 * as UTC only (no wall clock from PostgreSQL in these DTOs): this formats a
 * past instant for reading, with no effect on any schedule. Documented as a
 * contract gap in docs/LOYALTY_CONTRACT.md (Interface professionnelle).
 */
export function instantLabel(iso: string, timeZone: string | null) {
  const key = timeZone ?? "UTC";
  let format = instantFormats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("fr-FR", {
        timeZone: key,
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      format = new Intl.DateTimeFormat("fr-FR", {
        timeZone: "UTC",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    instantFormats.set(key, format);
  }
  return format.format(new Date(iso));
}
