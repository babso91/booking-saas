import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type {
  CreateStaffInput,
  RevokeAccessInput,
  SendInviteInput,
  UpdateStaffInput,
} from "@/features/team/schemas";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her team (docs/TEAM_CONTRACT.md). Every call goes through a database
// function that checks the role (owner or admin), the business, the
// revision and replays by operationId; the shapes below are the ones the
// screen's contract names (src/features/team/contract.ts on the UI side).

export type TeamRole = "owner" | "admin" | "practitioner";

export type TeamMemberDto = {
  id: string;
  revision: number;
  displayName: string;
  bookable: boolean;
  serviceIds: string[];
  access: { role: TeamRole; email: string } | null;
  invite: {
    status: "pending" | "accepted" | "expired" | "revoked";
    email: string;
    role: TeamRole;
    expiresAt: string | null;
  } | null;
  upcomingAppointments: number;
};

export type TeamDto = {
  members: TeamMemberDto[];
  services: { id: string; name: string }[];
};

/** `team_` + 32 random bytes; only the SHA-256 (hex) is stored. */
export function generateTeamInviteToken(): string {
  return `team_${randomBytes(32).toString("base64url")}`;
}

export function hashTeamInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function getTeam(
  client: AppSupabaseClient,
  businessId: string,
): Promise<TeamDto> {
  const { data, error } = await client.rpc("get_team", {
    p_business_id: businessId,
  });
  if (error) throw databaseException(error);
  return data as unknown as TeamDto;
}

export async function createStaff(
  client: AppSupabaseClient,
  businessId: string,
  input: CreateStaffInput,
): Promise<TeamMemberDto> {
  const { data, error } = await client.rpc("create_staff_member", {
    p_business_id: businessId,
    p_operation_id: input.operationId,
    p_display_name: input.displayName,
    p_bookable: input.bookable,
    p_service_ids: input.serviceIds,
  });
  if (error) throw databaseException(error);
  return data as unknown as TeamMemberDto;
}

export async function updateStaff(
  client: AppSupabaseClient,
  businessId: string,
  input: UpdateStaffInput,
): Promise<TeamMemberDto> {
  const { data, error } = await client.rpc("update_staff_member", {
    p_business_id: businessId,
    p_operation_id: input.operationId,
    p_staff_id: input.staffId,
    p_expected_revision: input.expectedRevision,
    p_display_name: input.displayName,
    p_bookable: input.bookable,
    p_service_ids: input.serviceIds,
  });
  if (error) throw databaseException(error);
  return data as unknown as TeamMemberDto;
}

/**
 * A new invitation; the previous one stops working. Returns the profile and
 * the one-time token, for the email transport only (never stored, never
 * returned to the screen).
 */
export async function sendInvite(
  client: AppSupabaseClient,
  businessId: string,
  input: SendInviteInput,
): Promise<{ member: TeamMemberDto; token: string }> {
  const token = generateTeamInviteToken();
  const { data, error } = await client.rpc("send_team_invitation", {
    p_business_id: businessId,
    p_operation_id: input.operationId,
    p_staff_id: input.staffId,
    p_expected_revision: input.expectedRevision,
    p_email: input.email,
    p_role: input.role,
    p_token_hash: hashTeamInviteToken(token),
  });
  if (error) throw databaseException(error);
  return { member: data as unknown as TeamMemberDto, token };
}

export async function revokeAccess(
  client: AppSupabaseClient,
  businessId: string,
  input: RevokeAccessInput,
): Promise<TeamMemberDto> {
  const { data, error } = await client.rpc("revoke_team_access", {
    p_business_id: businessId,
    p_operation_id: input.operationId,
    p_staff_id: input.staffId,
    p_expected_revision: input.expectedRevision,
  });
  if (error) throw databaseException(error);
  return data as unknown as TeamMemberDto;
}

/** The signed-in person joins the business; returns its id. */
export async function acceptInvite(
  client: AppSupabaseClient,
  token: string,
): Promise<string> {
  const { data, error } = await client.rpc("accept_team_invitation", {
    p_token_hash: hashTeamInviteToken(token),
  });
  if (error) throw databaseException(error);
  return data;
}
