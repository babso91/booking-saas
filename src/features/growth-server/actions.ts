"use server";

import { revalidatePath } from "next/cache";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  campaignIdSchema,
  estimateSchema,
  scheduleSchema,
  setStateSchema,
} from "@/features/growth-server/schemas";
import { databaseException } from "@/lib/supabase/errors";

// Campaigns (docs/GROWTH_CAMPAIGNS_CONTRACT.md): the CampaignActions object
// of the screen, owner and admin only. Counts only, never a customer's
// name; every send is simulated.

type Dto = Record<string, unknown>;

export async function estimateCampaignAction(input: unknown) {
  return runBusinessAction(
    estimateSchema,
    input,
    async ({ client, businessId }, data) => {
      const { data: estimate, error } = await client.rpc("growth_estimate", {
        p_business_id: businessId,
        p_criteria: data.criteria,
        p_channel: data.channel,
        p_message: data.message,
      });
      if (error) throw databaseException(error);
      return estimate as unknown as Dto;
    },
  );
}

/** `estimate_stale`, `quota_exceeded`; replayed by `requestId`. */
export async function scheduleCampaignAction(input: unknown) {
  const result = await runBusinessAction(
    scheduleSchema,
    input,
    async ({ client, businessId }, data) => {
      const { data: campaign, error } = await client.rpc("growth_schedule", {
        p_business_id: businessId,
        p_estimate_id: data.estimateId,
        p_max_units: data.maxUnits,
        p_request_id: data.requestId,
      });
      if (error) throw databaseException(error);
      return campaign as unknown as Dto;
    },
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

export async function readCampaignAction(input: unknown) {
  return runBusinessAction(
    campaignIdSchema,
    input,
    async ({ client, businessId }, { campaignId }) => {
      const { data, error } = await client.rpc("growth_read", {
        p_business_id: businessId,
        p_campaign_id: campaignId,
      });
      if (error) throw databaseException(error);
      return data as unknown as Dto;
    },
  );
}

/** pause, resume, cancel; `version_conflict`, `campaign_closed`. */
export async function setCampaignStateAction(input: unknown) {
  const result = await runBusinessAction(
    setStateSchema,
    input,
    async ({ client, businessId }, data) => {
      const { data: campaign, error } = await client.rpc("growth_set_state", {
        p_business_id: businessId,
        p_campaign_id: data.campaignId,
        p_expected_version: data.expectedVersion,
        p_request_id: data.requestId,
        p_action: data.action,
      });
      if (error) throw databaseException(error);
      return campaign as unknown as Dto;
    },
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}
