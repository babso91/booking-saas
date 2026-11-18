"use client";

import { useEffect, useState } from "react";

import { callAction } from "@/features/auth/client/call-action";
import { getTierProgressAction } from "@/features/loyalty/growth/actions";

import type { TierProgressDto } from "./contract";
import { TierProgress } from "./tier-progress";

/**
 * Her client's tier on the profile (docs/LOYALTY_TIERS_CONTRACT.md), read
 * from the server. Nothing is shown while she has no tiers, or if it
 * cannot be read: the profile stays complete without it.
 */
export function ClientTier({
  clientId,
  timezone,
}: {
  clientId: string;
  timezone: string;
}) {
  const [progress, setProgress] = useState<TierProgressDto | null>(null);
  useEffect(() => {
    let alive = true;
    void callAction(() => getTierProgressAction({ clientId })).then(
      (result) => {
        if (alive && result.ok) setProgress(result.data);
      },
    );
    return () => {
      alive = false;
    };
  }, [clientId]);
  if (!progress || progress.tiers.length === 0) return null;
  return <TierProgress progress={progress} timezone={timezone} reader="pro" />;
}
