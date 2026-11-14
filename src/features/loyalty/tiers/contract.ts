// VIP progression and referral (R4-02). PROPOSED contract
// (docs/LOYALTY_TIERS_PROPOSAL.md): no server serves it yet. The screens
// take their actions as a whole; only the design preview and the tests
// give them an in-memory server. No real page shows tiers or referral
// until Cloud provides them.
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
  /** When the window counted now ends (then visits are counted again). */
  windowEnd: string;
  ruleVersion: number;
};

export type ReferralLinkDto = {
  url: string;
  expiresAt: string;
  state: "active" | "expired" | "revoked";
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
