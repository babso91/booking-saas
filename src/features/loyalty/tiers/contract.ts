// VIP progression and referral (R4-02), as served
// (docs/LOYALTY_TIERS_CONTRACT.md). The screens take their actions as a
// whole: the professional's area gives them the real ones, the design
// preview and the tests an in-memory server.
//
// A tier is earned by completed visits in a window, independently of the
// points balance: spending points never lowers it.

export type TierDto = {
  id: string;
  name: string;
  /** Completed visits in the window to reach it. */
  threshold: number;
  /** What it brings, in her words (shown as is). */
  perk: string | null;
};

export type TierProgressDto = {
  /** Her tiers, lowest first. */
  tiers: TierDto[];
  /** The tier reached; null: none yet. */
  tierId: string | null;
  /** Completed visits counted in the current window. */
  currentValue: number;
  /** Visits needed for the next tier; null at the top or without tiers. */
  nextThreshold: number | null;
  /** The sliding window, in days. */
  windowDays: number;
  /**
   * When the oldest counted visit leaves the window (the count may go
   * down then); null without any counted visit.
   */
  windowEnd: string | null;
  ruleVersion: number;
};

export type ReferralLinkDto = {
  url: string;
  expiresAt: string;
  /** unavailable: the business stopped offering referral (not shared). */
  state: "active" | "expired" | "revoked" | "unavailable";
};

export type TierResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type ReferralActions = {
  /** The client's current link, or null when she has none. */
  current: () => Promise<TierResult<ReferralLinkDto | null>>;
  create: (input: {
    requestId: string;
  }) => Promise<TierResult<ReferralLinkDto>>;
};
