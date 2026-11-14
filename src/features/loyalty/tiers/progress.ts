import type { TierDto, TierProgressDto } from "./contract";

// Where a client stands among the tiers, read from the server's progress:
// nothing is counted here, only placed.

export type Standing = {
  current: TierDto | null;
  next: TierDto | null;
  /** Visits still needed for the next tier; 0 at the top. */
  missing: number;
  /** 0 to 1, from the current tier's threshold to the next one's. */
  ratio: number;
};

export function standingOf(progress: TierProgressDto): Standing {
  const tiers = [...progress.tiers].sort((a, b) => a.threshold - b.threshold);
  const current = tiers.find((tier) => tier.id === progress.tierId) ?? null;
  const next =
    tiers.find((tier) => tier.threshold > progress.currentValue) ?? null;
  if (!next) return { current, next: null, missing: 0, ratio: 1 };
  const from = current?.threshold ?? 0;
  const span = Math.max(1, next.threshold - from);
  return {
    current,
    next,
    missing: next.threshold - progress.currentValue,
    ratio: Math.min(1, Math.max(0, (progress.currentValue - from) / span)),
  };
}
