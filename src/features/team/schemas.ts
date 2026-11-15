import { z } from "zod";

import { passwordSchema } from "@/features/auth/schemas/auth";

// Inputs of her team's actions (docs/TEAM_CONTRACT.md). The database checks
// everything again (role, business, revision, services).

const revision = z.number().int().min(1).max(2_147_483_647);
const displayName = z
  .string()
  .trim()
  .min(1, "Le nom est obligatoire.")
  .max(80, "80 caractères au plus.");
const serviceIds = z.array(z.uuid()).max(200);

export const createStaffSchema = z.object({
  operationId: z.uuid(),
  displayName,
  bookable: z.boolean(),
  serviceIds,
});

export const updateStaffSchema = z.object({
  operationId: z.uuid(),
  staffId: z.uuid(),
  expectedRevision: revision,
  displayName,
  bookable: z.boolean(),
  serviceIds,
});

export const sendInviteSchema = z.object({
  operationId: z.uuid(),
  staffId: z.uuid(),
  expectedRevision: revision,
  email: z.email("Adresse e-mail invalide.").trim().toLowerCase().max(254),
  role: z.enum(["admin", "practitioner"]),
});

export const revokeAccessSchema = z.object({
  operationId: z.uuid(),
  staffId: z.uuid(),
  expectedRevision: revision,
});

/** A team invitation's token (`team_` + 32 random bytes, base64url). */
export const TEAM_INVITE_TOKEN_PATTERN = /^team_[A-Za-z0-9_-]{43}$/;

const inviteToken = z.string().regex(TEAM_INVITE_TOKEN_PATTERN);

/**
 * `token`: from her link. Absent: the invitation kept on this device by her
 * sign-up through it (`beta_invitation_required` if there is none).
 */
export const acceptInviteSchema = z.object({
  token: inviteToken.optional(),
});

/** After her recovery link: her own password, then she joins. */
export const completeTeamInviteSchema = z.object({
  password: passwordSchema,
  token: inviteToken.optional(),
});

export type CreateStaffInput = z.output<typeof createStaffSchema>;
export type UpdateStaffInput = z.output<typeof updateStaffSchema>;
export type SendInviteInput = z.output<typeof sendInviteSchema>;
export type RevokeAccessInput = z.output<typeof revokeAccessSchema>;
export type CompleteTeamInviteInput = z.output<typeof completeTeamInviteSchema>;
