"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  adjustPoints,
  cancelRedemption,
  configureLoyaltyProgram,
  createReward,
  fulfilRedemption,
  getClientLoyalty,
  getLoyaltyProgram,
  listClientLedger,
  listClientRedemptions,
  listLoyaltyBalances,
  listRewards,
  redeemReward,
  reverseAdjustment,
  setLoyaltyServiceRule,
  updateReward,
} from "@/features/loyalty/data/loyalty";
import {
  adjustPointsSchema,
  balancesSchema,
  cancelRedemptionSchema,
  clientLoyaltySchema,
  configureProgramSchema,
  createRewardSchema,
  fulfilRedemptionSchema,
  ledgerPageSchema,
  redeemRewardSchema,
  reverseAdjustmentSchema,
  setServiceRuleSchema,
  updateRewardSchema,
} from "@/features/loyalty/schemas/loyalty";

// Professional loyalty contracts. The business always comes from the
// session (runBusinessAction), never from the input; every result is an
// ActionResult with a stable error code. Contract: docs/LOYALTY_CONTRACT.md.

function revalidateLoyalty() {
  revalidatePath("/app", "layout");
}

export async function getLoyaltyProgramAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    getLoyaltyProgram(client, businessId),
  );
}

/** Whole configuration, based on `expectedVersion` (`stale_loyalty_program`). */
export async function configureLoyaltyProgramAction(input: unknown) {
  const result = await runBusinessAction(
    configureProgramSchema,
    input,
    ({ client, businessId }, data) =>
      configureLoyaltyProgram(client, businessId, data),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

/** Sets (or, with `points: null`, removes) the earning rule of one service. */
export async function setLoyaltyServiceRuleAction(input: unknown) {
  const result = await runBusinessAction(
    setServiceRuleSchema,
    input,
    ({ client, businessId }, data) =>
      setLoyaltyServiceRule(client, businessId, data.serviceId, data.points),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

export async function listRewardsAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    listRewards(client, businessId),
  );
}

/** Idempotent by `requestId` (`idempotency_conflict` for another command). */
export async function createRewardAction(input: unknown) {
  const result = await runBusinessAction(
    createRewardSchema,
    input,
    ({ client, businessId }, data) => createReward(client, businessId, data),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

/** Every editable field, based on `expectedVersion` (`stale_reward`). */
export async function updateRewardAction(input: unknown) {
  const result = await runBusinessAction(
    updateRewardSchema,
    input,
    ({ client, businessId }, data) => updateReward(client, businessId, data),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

/** Balance, totals and the eligibility of every reward for one customer. */
export async function getClientLoyaltyAction(input: unknown) {
  return runBusinessAction(
    clientLoyaltySchema,
    input,
    ({ client, businessId }, data) =>
      getClientLoyalty(client, businessId, data.clientId),
  );
}

export async function listClientLoyaltyLedgerAction(input: unknown) {
  return runBusinessAction(
    ledgerPageSchema,
    input,
    ({ client, businessId }, data) =>
      listClientLedger(client, businessId, data),
  );
}

export async function listLoyaltyBalancesAction(input: unknown) {
  return runBusinessAction(
    balancesSchema,
    input,
    ({ client, businessId }, data) =>
      listLoyaltyBalances(client, businessId, data.clientIds),
  );
}

export async function listClientRedemptionsAction(input: unknown) {
  return runBusinessAction(
    clientLoyaltySchema,
    input,
    ({ client, businessId }, data) =>
      listClientRedemptions(client, businessId, data.clientId),
  );
}

/** Debits and issues a reward, once per `requestId`. */
export async function redeemRewardAction(input: unknown) {
  const result = await runBusinessAction(
    redeemRewardSchema,
    input,
    ({ client, businessId }, data) => redeemReward(client, businessId, data),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

export async function fulfilRedemptionAction(input: unknown) {
  const result = await runBusinessAction(
    fulfilRedemptionSchema,
    input,
    ({ client, businessId }, data) =>
      fulfilRedemption(
        client,
        businessId,
        data.redemptionId,
        data.appointmentId,
      ),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

export async function cancelRedemptionAction(input: unknown) {
  const result = await runBusinessAction(
    cancelRedemptionSchema,
    input,
    ({ client, businessId }, data) =>
      cancelRedemption(client, businessId, data.redemptionId, data.reason),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

/** Manual credit or debit with a reason, once per `requestId`. */
export async function adjustPointsAction(input: unknown) {
  const result = await runBusinessAction(
    adjustPointsSchema,
    input,
    ({ client, businessId }, data) => adjustPoints(client, businessId, data),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}

export async function reverseAdjustmentAction(input: unknown) {
  const result = await runBusinessAction(
    reverseAdjustmentSchema,
    input,
    ({ client, businessId }, data) =>
      reverseAdjustment(client, businessId, data.entryId, data.reason),
  );
  if (result.ok) revalidateLoyalty();
  return result;
}
