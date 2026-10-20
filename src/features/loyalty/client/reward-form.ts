import {
  parsePriceCents,
  priceInput,
} from "@/features/services/client/service-form";

import type { RewardDto, RewardType } from "../types";

// The reward form and the commands sent to createRewardAction and
// updateRewardAction. PostgreSQL stays the authority (docs/LOYALTY_CONTRACT.md).
//
// Historical values: a reward written before today's bounds (a longer
// description, a larger cost, a percentage over 100, untrimmed text) is kept
// by the backend only when it is sent back exactly as stored. So an edit
// sends every field the professional did not touch as it was read, byte for
// byte (name and description raw, never trimmed here), and checks bounds
// only on the fields she changed.

export type RewardDraft = {
  name: string;
  description: string;
  /** Points, as typed. */
  points: string;
  rewardType: RewardType;
  /** fixed_discount: major units as typed ("5", "7,50"); percentage: "10". */
  value: string;
  serviceId: string;
  active: boolean;
};

export type RewardField =
  "name" | "description" | "points" | "value" | "serviceId";

export const REWARD_NAME_MAX = 120;
export const REWARD_DESCRIPTION_MAX = 1000;
export const REWARD_POINTS_MAX = 1_000_000;
export const FIXED_DISCOUNT_MAX_CENTS = 10_000_000;

export const EMPTY_REWARD: RewardDraft = {
  name: "",
  description: "",
  points: "",
  rewardType: "fixed_discount",
  value: "",
  serviceId: "",
  active: true,
};

export const rewardTypeLabels: Record<RewardType, string> = {
  fixed_discount: "Remise en euros",
  percentage_discount: "Remise en pourcentage",
  free_service: "Prestation offerte",
};

function valueInput(reward: RewardDto) {
  if (reward.rewardValue === null) return "";
  return reward.rewardType === "fixed_discount"
    ? priceInput(reward.rewardValue)
    : String(reward.rewardValue);
}

export function rewardDraft(reward: RewardDto): RewardDraft {
  return {
    name: reward.name,
    description: reward.description ?? "",
    points: String(reward.pointsRequired),
    rewardType: reward.rewardType,
    value: valueInput(reward),
    serviceId: reward.serviceId ?? "",
    active: reward.active,
  };
}

type Checked = {
  name: string;
  description: string | null;
  pointsRequired: number;
  rewardValue: number | null;
  serviceId: string | null;
};

export type RewardCheck =
  | { ok: true; values: Checked }
  | { ok: false; errors: Partial<Record<RewardField, string>> };

const integer = (text: string) =>
  /^\d{1,10}$/.test(text.trim()) ? Number(text.trim()) : null;

/**
 * Checks a draft. `base`: the reward as read (an edit), whose untouched
 * values are passed through as stored.
 */
export function checkReward(
  draft: RewardDraft,
  base: RewardDto | null,
): RewardCheck {
  const errors: Partial<Record<RewardField, string>> = {};
  const initial = base ? rewardDraft(base) : null;
  const changed = (field: keyof RewardDraft) =>
    !initial || draft[field] !== initial[field];

  // Name and description: raw when unchanged; a new value is the trimmed
  // text (the backend normalises it the same way).
  let name = base?.name ?? "";
  if (changed("name")) {
    name = draft.name.trim();
    if (!name) errors.name = "Donne un nom à la récompense.";
    else if (name.length > REWARD_NAME_MAX)
      errors.name = `${REWARD_NAME_MAX} caractères au plus.`;
  }

  let description = base ? base.description : null;
  if (changed("description")) {
    description = draft.description.trim() || null;
    if (description && description.length > REWARD_DESCRIPTION_MAX)
      errors.description = `${REWARD_DESCRIPTION_MAX} caractères au plus.`;
  }

  let pointsRequired = base?.pointsRequired ?? 0;
  if (changed("points")) {
    const value = integer(draft.points);
    if (value === null || value < 1 || value > REWARD_POINTS_MAX) {
      errors.points = `Indique un nombre entier de 1 à ${REWARD_POINTS_MAX.toLocaleString("fr-FR")}.`;
    } else {
      pointsRequired = value;
    }
  }

  let rewardValue: number | null = null;
  if (draft.rewardType !== "free_service") {
    rewardValue = base?.rewardValue ?? null;
    if (changed("value") || rewardValue === null) {
      if (draft.rewardType === "fixed_discount") {
        const cents = parsePriceCents(draft.value);
        if (cents === null || cents < 1 || cents > FIXED_DISCOUNT_MAX_CENTS) {
          errors.value = draft.value.trim()
            ? "Indique un montant valide (ex. 5 ou 7,50), jusqu’à 100 000 €."
            : "Indique le montant de la remise.";
        } else {
          rewardValue = cents;
        }
      } else {
        const percent = integer(draft.value);
        if (percent === null || percent < 1 || percent > 100) {
          errors.value = "Indique un pourcentage entier de 1 à 100.";
        } else {
          rewardValue = percent;
        }
      }
    }
  }

  let serviceId: string | null = null;
  if (draft.rewardType === "free_service") {
    serviceId = draft.serviceId || null;
    if (!serviceId) errors.serviceId = "Choisis la prestation offerte.";
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        values: { name, description, pointsRequired, rewardValue, serviceId },
      };
}

export function rewardDirty(draft: RewardDraft, base: RewardDto | null) {
  const initial = base ? rewardDraft(base) : EMPTY_REWARD;
  return (Object.keys(initial) as (keyof RewardDraft)[]).some(
    (field) => draft[field] !== initial[field],
  );
}

export function createCommand(
  draft: RewardDraft,
  values: Checked,
  requestId: string,
) {
  return {
    requestId,
    name: values.name,
    description: values.description,
    pointsRequired: values.pointsRequired,
    rewardType: draft.rewardType,
    rewardValue: values.rewardValue,
    serviceId: values.serviceId,
    active: draft.active,
  };
}

/** Every editable field; `active` as given (the toggle reuses it). */
export function updateCommand(
  base: RewardDto,
  values: Checked,
  active: boolean,
) {
  return {
    rewardId: base.id,
    rewardType: base.rewardType,
    expectedVersion: base.version,
    name: values.name,
    description: values.description,
    pointsRequired: values.pointsRequired,
    rewardValue: values.rewardValue,
    serviceId: values.serviceId,
    active,
  };
}

/**
 * Activation change of a reward as read: every other field exactly as
 * stored. Null when the reward cannot be saved as it is (a historical free
 * service without a service: the backend requires one).
 */
export function toggleCommand(reward: RewardDto) {
  if (reward.rewardType === "free_service" && reward.serviceId === null)
    return null;
  return {
    rewardId: reward.id,
    rewardType: reward.rewardType,
    expectedVersion: reward.version,
    name: reward.name,
    description: reward.description,
    pointsRequired: reward.pointsRequired,
    rewardValue:
      reward.rewardType === "free_service" ? null : reward.rewardValue,
    serviceId: reward.rewardType === "free_service" ? reward.serviceId : null,
    active: !reward.active,
  };
}
