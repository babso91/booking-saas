import { callAction } from "@/features/auth/client/call-action";
import {
  estimateCampaignAction,
  readCampaignAction,
  scheduleCampaignAction,
  setCampaignStateAction,
} from "@/features/growth-server/actions";

import type {
  AudienceEstimate,
  CampaignActions,
  CampaignDto,
  GrowthResult,
} from "./contract";

// The campaign screens on Cloud's Server Actions
// (docs/GROWTH_CAMPAIGNS_CONTRACT.md), served as proposed; an error keeps
// its code only.

async function run<T>(
  action: () => Promise<
    { ok: true; data: unknown } | { ok: false; error: { code: string } }
  >,
): Promise<GrowthResult<T>> {
  const result = (await callAction(action as never)) as
    { ok: true; data: T } | { ok: false; error: { code: string } };
  return result.ok ? result : { ok: false, error: { code: result.error.code } };
}

export const realCampaignActions: CampaignActions = {
  estimate: (input) =>
    run<AudienceEstimate>(() => estimateCampaignAction(input)),
  schedule: (input) => run<CampaignDto>(() => scheduleCampaignAction(input)),
  read: (campaignId) =>
    run<CampaignDto>(() => readCampaignAction({ campaignId })),
  setState: (input) => run<CampaignDto>(() => setCampaignStateAction(input)),
};
