"use client";

import { useMemo } from "react";

import type {
  ReferralActions,
  TierResult,
} from "@/features/loyalty/tiers/contract";
import { ReferralCard } from "@/features/loyalty/tiers/referral-card";
import { TierProgress } from "@/features/loyalty/tiers/tier-progress";

import {
  createReferral,
  fetchReferral,
  fetchTierProgress,
  type HubResult,
} from "../client/api";
import { useClientHub, useHubRead } from "../client/session";

/**
 * Her tier and her referral link in her space
 * (docs/LOYALTY_TIERS_CONTRACT.md), under the Hub's account rule: an answer
 * is shown only for the account the page confirmed. Nothing is shown when
 * the business has no tiers; the link only when it offers referral.
 */
export function HubTiers({
  businessId,
  businessName,
  timezone,
}: {
  businessId: string;
  businessName: string;
  timezone: string;
}) {
  const progress = useHubRead(`tiers:${businessId}`, (signal) =>
    fetchTierProgress(businessId, signal),
  );
  const { session, accepts, distrust, recheck } = useClientHub();
  const owner = session.generation;
  const referral = useMemo<ReferralActions>(() => {
    function checked<T>(result: HubResult<T>): TierResult<T> {
      if (!result.ok) {
        if (result.error.code === "client_hub_unauthenticated") distrust(owner);
        if (result.error.code === "client_hub_not_found") recheck();
        return { ok: false, error: { code: result.error.code } };
      }
      if (!accepts(owner, result.account)) {
        distrust(owner);
        return { ok: false, error: { code: "network" } };
      }
      return { ok: true, data: result.data };
    }
    return {
      current: async () => checked(await fetchReferral(businessId)),
      create: async ({ requestId }) =>
        checked(await createReferral(businessId, requestId)),
    };
  }, [accepts, businessId, distrust, owner, recheck]);

  return (
    <>
      {progress.status === "ready" && progress.data.tiers.length > 0 ? (
        <TierProgress
          progress={progress.data}
          timezone={timezone}
          reader="client"
        />
      ) : null}
      <ReferralCard
        actions={referral}
        businessName={businessName}
        timezone={timezone}
      />
    </>
  );
}
