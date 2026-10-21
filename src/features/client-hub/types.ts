// Contracts of the Client Hub (docs/CLIENT_HUB_CONTRACT.md). Instants are
// ISO 8601 strings; amounts are integers in minor units; points integers.

export type ClientHubBusinessDto = {
  businessId: string;
  name: string;
  slug: string;
  timezone: string;
  location: string | null;
  /** The customer's own name in this business's records. */
  customer: { firstName: string; lastName: string | null };
};

export type ClientHubProfileDto = {
  email: string;
  /** Businesses that authorized Client Hub access for this email. */
  businesses: ClientHubBusinessDto[];
};

export type ClientHubAppointmentDto = {
  id: string;
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  startsAt: string;
  endsAt: string;
  serviceName: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
};

export type ClientHubAppointmentDetailDto = ClientHubAppointmentDto & {
  business: {
    name: string;
    slug: string;
    timezone: string;
    location: string | null;
    cancellationPolicy: string | null;
  };
};

export type ClientHubAppointmentsPageDto = {
  items: ClientHubAppointmentDto[];
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
};

export type ClientHubRewardType =
  "percentage_discount" | "fixed_discount" | "free_service";

export type ClientHubRewardDto = {
  id: string;
  name: string;
  description: string | null;
  pointsRequired: number;
  rewardType: ClientHubRewardType;
  rewardValue: number | null;
  currency: string | null;
  serviceName: string | null;
  /** Information only: redemption is done by the professional. */
  eligible: boolean;
  missingPoints: number;
};

export type ClientHubIssuedRewardDto = {
  id: string;
  status: "issued" | "fulfilled" | "cancelled";
  name: string;
  rewardType: ClientHubRewardType;
  rewardValue: number | null;
  currency: string | null;
  serviceName: string | null;
  pointsSpent: number;
  issuedAt: string;
  fulfilledAt: string | null;
  cancelledAt: string | null;
};

export type ClientHubLoyaltyDto = {
  programActive: boolean;
  balance: number;
  rewards: ClientHubRewardDto[];
  /** The 50 most recent. */
  issuedRewards: ClientHubIssuedRewardDto[];
};

export type ClientHubLedgerEntryDto = {
  id: string;
  type:
    | "appointment_completed"
    | "manual_adjustment"
    | "reward_redeemed"
    | "correction";
  pointsDelta: number;
  balanceAfter: number;
  createdAt: string;
  appointmentId: string | null;
  /** appointment_completed: the service of the visit. */
  serviceName: string | null;
  /** reward_redeemed, or the refund of one: the reward. */
  rewardName: string | null;
  /** This entry compensates another one. */
  isReversal: boolean;
  /** This entry was compensated later. */
  reversed: boolean;
};

export type ClientHubLedgerPageDto = {
  items: ClientHubLedgerEntryDto[];
  nextCursor: string | null;
};

export type ClientHubAccessDto = {
  clientId: string;
  granted: boolean;
  /**
   * The email vouched for (null when not granted). Changing the record's
   * email revokes the access: grant it again for the new one.
   */
  email: string | null;
  grantedAt: string | null;
};
