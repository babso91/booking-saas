import "server-only";

import { z } from "zod";

import type {
  AdjustPointsInput,
  ConfigureProgramInput,
  CreateRewardInput,
  LedgerPageInput,
  UpdateRewardInput,
} from "@/features/loyalty/schemas/loyalty";
import type {
  ClientLoyaltySummaryDto,
  LoyaltyBalanceDto,
  LoyaltyLedgerEntryDto,
  LoyaltyLedgerPageDto,
  LoyaltyProgramDto,
  RedemptionDto,
  RewardDto,
} from "@/features/loyalty/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Tables } from "@/types/database.generated";

// Professional access to the loyalty engine, under the user's session. Reads
// go through RLS (members of the business only) and are additionally scoped
// to the business resolved from the session; every write is one SQL function
// call (public.loyalty_*) that checks the membership again, validates, locks
// and writes the ledger atomically. Nothing here trusts the browser for
// authorization, and nothing is reachable without a professional session.

const REWARD_COLUMNS =
  "id, name, description, points_required, reward_type, reward_value, currency, service_id, active, version";

type RewardRow = Pick<
  Tables<"rewards">,
  | "id"
  | "name"
  | "description"
  | "points_required"
  | "reward_type"
  | "reward_value"
  | "currency"
  | "service_id"
  | "active"
  | "version"
>;

function toRewardDto(row: RewardRow): RewardDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    pointsRequired: row.points_required,
    rewardType: row.reward_type,
    rewardValue: row.reward_value,
    currency: row.currency,
    serviceId: row.service_id,
    active: row.active,
    version: row.version,
  };
}

/** NUMERIC as JSON number (≤ 4 decimals, ≤ 3 digits): its shortest string is exact. */
function decimalString(value: number | null) {
  return value === null ? null : String(value);
}

export async function getLoyaltyProgram(
  client: AppSupabaseClient,
  businessId: string,
): Promise<LoyaltyProgramDto> {
  const [program, rules] = await Promise.all([
    client
      .from("loyalty_programs")
      .select(
        "active, accrual_mode, points_per_completed_appointment, points_per_euro, version",
      )
      .eq("business_id", businessId)
      .maybeSingle(),
    client
      .from("loyalty_service_rules")
      .select("service_id, points")
      .eq("business_id", businessId)
      .order("service_id"),
  ]);

  if (program.error) throw databaseException(program.error);
  if (rules.error) throw databaseException(rules.error);

  const serviceRules = rules.data.map((rule) => ({
    serviceId: rule.service_id,
    points: rule.points,
  }));

  if (!program.data) {
    // No row yet: the default, inactive program; configure with version 0.
    return {
      active: false,
      accrualMode: "appointment",
      pointsPerCompletedAppointment: 1,
      pointsPerEuro: null,
      version: 0,
      serviceRules,
    };
  }

  return {
    active: program.data.active,
    accrualMode: program.data.accrual_mode,
    pointsPerCompletedAppointment:
      program.data.points_per_completed_appointment,
    pointsPerEuro: decimalString(program.data.points_per_euro),
    version: program.data.version,
    serviceRules,
  };
}

/**
 * Replaces the whole configuration, if it is still at `expectedVersion`
 * (`stale_loyalty_program` otherwise). The same values again succeed.
 */
export async function configureLoyaltyProgram(
  client: AppSupabaseClient,
  businessId: string,
  input: ConfigureProgramInput,
): Promise<LoyaltyProgramDto> {
  const { error } = await client.rpc("loyalty_configure_program", {
    p_business_id: businessId,
    p_expected_version: input.expectedVersion,
    p_active: input.active,
    p_accrual_mode: input.accrualMode,
    p_points_per_completed_appointment: input.pointsPerCompletedAppointment,
    // ≤ 7 significant digits: the number serialises back to this decimal.
    p_points_per_euro:
      input.accrualMode === "spend" && input.pointsPerEuro
        ? Number(input.pointsPerEuro)
        : undefined,
  });

  if (error) throw databaseException(error);

  return getLoyaltyProgram(client, businessId);
}

export async function setLoyaltyServiceRule(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
  points: number | null,
): Promise<LoyaltyProgramDto> {
  const { error } = await client.rpc("loyalty_set_service_rule", {
    p_business_id: businessId,
    p_service_id: serviceId,
    // null removes the rule (the generated type has no null for integers).
    p_points: points as number,
  });

  if (error) throw databaseException(error);

  return getLoyaltyProgram(client, businessId);
}

export async function listRewards(
  client: AppSupabaseClient,
  businessId: string,
): Promise<RewardDto[]> {
  const { data, error } = await client
    .from("rewards")
    .select(REWARD_COLUMNS)
    .eq("business_id", businessId)
    .order("points_required")
    .order("name")
    .order("id");

  if (error) throw databaseException(error);

  return data.map(toRewardDto);
}

async function getReward(
  client: AppSupabaseClient,
  businessId: string,
  rewardId: string,
): Promise<RewardDto> {
  const { data, error } = await client
    .from("rewards")
    .select(REWARD_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", rewardId)
    .maybeSingle();

  if (error) throw databaseException(error);
  if (!data) throw new AppException("reward_not_found");

  return toRewardDto(data);
}

/** Once per `requestId`: a retry answers the reward it created, as it is now. */
export async function createReward(
  client: AppSupabaseClient,
  businessId: string,
  input: CreateRewardInput,
): Promise<RewardDto> {
  const { data, error } = await client.rpc("loyalty_create_reward", {
    p_business_id: businessId,
    p_request_id: input.requestId,
    p_name: input.name,
    // No SQL defaults here: an absent value is an explicit null.
    p_description: input.description as string,
    p_points_required: input.pointsRequired,
    p_reward_type: input.rewardType,
    p_reward_value: input.rewardValue as number,
    p_service_id: input.serviceId as string,
    p_active: input.active,
  });

  if (error) throw databaseException(error);

  return getReward(client, businessId, data);
}

export async function updateReward(
  client: AppSupabaseClient,
  businessId: string,
  input: UpdateRewardInput,
): Promise<RewardDto> {
  const { error } = await client.rpc("loyalty_update_reward", {
    p_business_id: businessId,
    p_reward_id: input.rewardId,
    p_expected_version: input.expectedVersion,
    p_name: input.name,
    // No SQL defaults here: an absent value is an explicit null.
    p_description: input.description as string,
    p_points_required: input.pointsRequired,
    p_reward_value: input.rewardValue as number,
    p_service_id: input.serviceId as string,
    p_active: input.active,
  });

  if (error) throw databaseException(error);

  return getReward(client, businessId, input.rewardId);
}

const summarySchema = z.object({
  clientId: z.uuid(),
  programActive: z.boolean(),
  balance: z.number().int(),
  pointsCredited: z.number().int(),
  pointsDebited: z.number().int(),
  issuedRedemptions: z.number().int(),
  rewards: z.array(
    z.object({
      rewardId: z.uuid(),
      pointsRequired: z.number().int(),
      eligible: z.boolean(),
      missingPoints: z.number().int(),
      unavailableReason: z
        .enum([
          "program_inactive",
          "inactive",
          "service_missing",
          "currency_missing",
        ])
        .nullable(),
    }),
  ),
});

export async function getClientLoyalty(
  client: AppSupabaseClient,
  businessId: string,
  clientId: string,
): Promise<ClientLoyaltySummaryDto> {
  const { data, error } = await client.rpc("loyalty_client_summary", {
    p_business_id: businessId,
    p_client_id: clientId,
  });

  if (error) throw databaseException(error);

  return summarySchema.parse(data);
}

const redemptionSnapshotSchema = z
  .object({
    id: z.uuid(),
    rewardId: z.uuid(),
    rewardName: z.string(),
    rewardType: z.enum([
      "percentage_discount",
      "fixed_discount",
      "free_service",
    ]),
    rewardValue: z.number().int().nullable(),
    currency: z.string().nullable(),
    serviceId: z.uuid().nullable(),
    serviceName: z.string().nullable(),
    pointsSpent: z.number().int(),
    status: z.enum(["issued", "fulfilled", "cancelled"]),
    redeemedAt: z.string(),
    fulfilledAt: z.string().nullable(),
    appointmentId: z.uuid().nullable(),
    cancelledAt: z.string().nullable(),
    cancellationReason: z.string().nullable(),
  })
  .nullable();

/** A page of one customer's ledger, newest first, with the balance after each entry. */
export async function listClientLedger(
  client: AppSupabaseClient,
  businessId: string,
  input: LedgerPageInput,
): Promise<LoyaltyLedgerPageDto> {
  const { data, error } = await client.rpc("loyalty_client_ledger", {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_before_seq: input.cursor === undefined ? undefined : Number(input.cursor),
    // One more than asked: tells whether a next page exists.
    p_limit: input.limit + 1,
  });

  if (error) throw databaseException(error);

  const rows = data.slice(0, input.limit);
  const entries: LoyaltyLedgerEntryDto[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    pointsDelta: row.points_delta,
    balanceAfter: row.balance_after,
    reason: row.reason,
    appointmentId: row.appointment_id,
    reversesEntryId: row.reverses_event_id,
    reversedByEntryId: row.reversed_by_event_id,
    awardGeneration: row.award_generation,
    details: (row.details ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
    createdBy: row.created_by,
    redemption: redemptionSnapshotSchema.parse(row.redemption),
  }));

  return {
    entries,
    nextCursor:
      data.length > input.limit ? String(rows[rows.length - 1]!.seq) : null,
  };
}

export async function listLoyaltyBalances(
  client: AppSupabaseClient,
  businessId: string,
  clientIds: string[] | undefined,
): Promise<LoyaltyBalanceDto[]> {
  let query = client
    .from("loyalty_balances")
    .select(
      "client_id, balance, points_credited, points_debited, last_entry_at",
    )
    .eq("business_id", businessId);
  if (clientIds) query = query.in("client_id", clientIds);

  const { data, error } = await query.order("client_id");

  if (error) throw databaseException(error);

  return data.map((row) => ({
    clientId: row.client_id!,
    balance: row.balance ?? 0,
    pointsCredited: row.points_credited ?? 0,
    pointsDebited: row.points_debited ?? 0,
    lastEntryAt: row.last_entry_at,
  }));
}

const REDEMPTION_COLUMNS =
  "id, reward_id, client_id, points_spent, status, redeemed_at, fulfilled_at, cancelled_at, cancellation_reason, appointment_id, loyalty_event_id, refund_event_id, reward_name_snapshot, reward_type_snapshot, reward_value_snapshot, reward_currency_snapshot, reward_service_id_snapshot, reward_service_name_snapshot";

type RedemptionRow = Pick<
  Tables<"reward_redemptions">,
  | "id"
  | "reward_id"
  | "client_id"
  | "points_spent"
  | "status"
  | "redeemed_at"
  | "fulfilled_at"
  | "cancelled_at"
  | "cancellation_reason"
  | "appointment_id"
  | "loyalty_event_id"
  | "refund_event_id"
  | "reward_name_snapshot"
  | "reward_type_snapshot"
  | "reward_value_snapshot"
  | "reward_currency_snapshot"
  | "reward_service_id_snapshot"
  | "reward_service_name_snapshot"
>;

function toRedemptionDto(row: RedemptionRow): RedemptionDto {
  return {
    id: row.id,
    rewardId: row.reward_id,
    clientId: row.client_id,
    status: row.status,
    pointsSpent: row.points_spent,
    reward: {
      name: row.reward_name_snapshot,
      type: row.reward_type_snapshot,
      value: row.reward_value_snapshot,
      currency: row.reward_currency_snapshot,
      serviceId: row.reward_service_id_snapshot,
      serviceName: row.reward_service_name_snapshot,
    },
    redeemedAt: row.redeemed_at,
    fulfilledAt: row.fulfilled_at,
    appointmentId: row.appointment_id,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    debitEntryId: row.loyalty_event_id,
    refundEntryId: row.refund_event_id,
  };
}

export async function listClientRedemptions(
  client: AppSupabaseClient,
  businessId: string,
  clientId: string,
): Promise<RedemptionDto[]> {
  const { data, error } = await client
    .from("reward_redemptions")
    .select(REDEMPTION_COLUMNS)
    .eq("business_id", businessId)
    .eq("client_id", clientId)
    .order("redeemed_at", { ascending: false })
    .order("id", { ascending: false });

  if (error) throw databaseException(error);

  return data.map(toRedemptionDto);
}

async function getRedemption(
  client: AppSupabaseClient,
  businessId: string,
  redemptionId: string,
): Promise<RedemptionDto> {
  const { data, error } = await client
    .from("reward_redemptions")
    .select(REDEMPTION_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", redemptionId)
    .maybeSingle();

  if (error) throw databaseException(error);
  if (!data) throw new AppException("redemption_not_found");

  return toRedemptionDto(data);
}

/** Debits the reward's points and issues it, once per `requestId`. */
export async function redeemReward(
  client: AppSupabaseClient,
  businessId: string,
  input: { clientId: string; rewardId: string; requestId: string },
): Promise<RedemptionDto> {
  const { data, error } = await client.rpc("loyalty_redeem_reward", {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_reward_id: input.rewardId,
    p_request_id: input.requestId,
  });

  if (error) throw databaseException(error);

  return getRedemption(client, businessId, data);
}

export async function fulfilRedemption(
  client: AppSupabaseClient,
  businessId: string,
  redemptionId: string,
  appointmentId: string | null | undefined,
): Promise<RedemptionDto> {
  const { error } = await client.rpc("loyalty_fulfil_redemption", {
    p_business_id: businessId,
    p_redemption_id: redemptionId,
    p_appointment_id: appointmentId ?? undefined,
  });

  if (error) throw databaseException(error);

  return getRedemption(client, businessId, redemptionId);
}

export async function cancelRedemption(
  client: AppSupabaseClient,
  businessId: string,
  redemptionId: string,
  reason: string | null,
): Promise<RedemptionDto> {
  const { error } = await client.rpc("loyalty_cancel_redemption", {
    p_business_id: businessId,
    p_redemption_id: redemptionId,
    p_reason: reason ?? undefined,
  });

  if (error) throw databaseException(error);

  return getRedemption(client, businessId, redemptionId);
}

/** A manual credit or debit, once per `requestId`; answers the entry id. */
export async function adjustPoints(
  client: AppSupabaseClient,
  businessId: string,
  input: AdjustPointsInput,
): Promise<{ entryId: string }> {
  const { data, error } = await client.rpc("loyalty_adjust_points", {
    p_business_id: businessId,
    p_client_id: input.clientId,
    p_request_id: input.requestId,
    p_points_delta: input.pointsDelta,
    p_reason: input.reason,
  });

  if (error) throw databaseException(error);

  return { entryId: data };
}

/** Compensates one manual adjustment (once); answers the reversal entry id. */
export async function reverseAdjustment(
  client: AppSupabaseClient,
  businessId: string,
  entryId: string,
  reason: string | null,
): Promise<{ entryId: string }> {
  const { data, error } = await client.rpc("loyalty_reverse_adjustment", {
    p_business_id: businessId,
    p_entry_id: entryId,
    p_reason: reason ?? undefined,
  });

  if (error) throw databaseException(error);

  return { entryId: data };
}
