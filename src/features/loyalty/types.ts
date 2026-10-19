// Contracts of the loyalty Server Actions (src/features/loyalty/actions).
// Points are integers; amounts are integers in minor units; instants are ISO
// 8601 strings in UTC. See docs/LOYALTY_CONTRACT.md.

export type LoyaltyAccrualMode = "appointment" | "spend";
export type RewardType =
  "percentage_discount" | "fixed_discount" | "free_service";
export type RedemptionStatus = "issued" | "fulfilled" | "cancelled";
export type LoyaltyEntryType =
  | "appointment_completed"
  | "manual_adjustment"
  | "reward_redeemed"
  | "correction";

export type LoyaltyProgramDto = {
  active: boolean;
  accrualMode: LoyaltyAccrualMode;
  /** "appointment" mode: points per completed appointment. */
  pointsPerCompletedAppointment: number;
  /** "spend" mode: points per 100 minor units, exact decimal string ("1.5"). */
  pointsPerEuro: string | null;
  /** Pass it back as `expectedVersion`; 0 when the business has no program row. */
  version: number;
  /** Overrides of the calculation per service (0 = earns nothing). */
  serviceRules: { serviceId: string; points: number }[];
};

export type RewardDto = {
  id: string;
  name: string;
  description: string | null;
  pointsRequired: number;
  rewardType: RewardType;
  /** fixed_discount: minor units of `currency`; percentage_discount: 1-100; free_service: null. */
  rewardValue: number | null;
  currency: string | null;
  /** free_service: the complimentary service (null if deleted or never set: unavailable). */
  serviceId: string | null;
  active: boolean;
  /** Pass it back as `expectedVersion` to edit this reward. */
  version: number;
};

export type RewardEligibilityDto = {
  rewardId: string;
  pointsRequired: number;
  eligible: boolean;
  /** Points still missing (0 when the balance suffices). */
  missingPoints: number;
  unavailableReason:
    | "program_inactive"
    | "inactive"
    | "service_missing"
    | "currency_missing"
    | null;
};

export type ClientLoyaltySummaryDto = {
  clientId: string;
  programActive: boolean;
  /** Sum of the ledger. Can be negative only after an award was reversed once spent. */
  balance: number;
  pointsCredited: number;
  pointsDebited: number;
  issuedRedemptions: number;
  rewards: RewardEligibilityDto[];
};

export type LoyaltyBalanceDto = {
  clientId: string;
  balance: number;
  pointsCredited: number;
  pointsDebited: number;
  lastEntryAt: string | null;
};

export type RedemptionSnapshotDto = {
  id: string;
  rewardId: string;
  rewardName: string;
  rewardType: RewardType;
  rewardValue: number | null;
  currency: string | null;
  serviceId: string | null;
  serviceName: string | null;
  pointsSpent: number;
  status: RedemptionStatus;
  redeemedAt: string;
  fulfilledAt: string | null;
  appointmentId: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
};

export type LoyaltyLedgerEntryDto = {
  id: string;
  type: LoyaltyEntryType;
  pointsDelta: number;
  /** The customer's balance right after this entry. */
  balanceAfter: number;
  reason: string;
  appointmentId: string | null;
  /** For a correction: the entry it compensates. */
  reversesEntryId: string | null;
  /** The correction that compensated this entry, if any. */
  reversedByEntryId: string | null;
  /** appointment_completed: 1, then 2 after a reopen and a new completion… */
  awardGeneration: number | null;
  /** Machine-readable source (calculation of an award, redemption id…). */
  details: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
  /** The redemption paid (or refunded) by this entry. */
  redemption: RedemptionSnapshotDto | null;
};

export type LoyaltyLedgerPageDto = {
  entries: LoyaltyLedgerEntryDto[];
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
};

export type RedemptionDto = {
  id: string;
  rewardId: string;
  clientId: string;
  status: RedemptionStatus;
  pointsSpent: number;
  /** The reward as it was when issued. */
  reward: {
    name: string;
    type: RewardType;
    value: number | null;
    currency: string | null;
    serviceId: string | null;
    serviceName: string | null;
  };
  redeemedAt: string;
  fulfilledAt: string | null;
  appointmentId: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  debitEntryId: string;
  refundEntryId: string | null;
};
