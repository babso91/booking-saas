import { z } from "zod";

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

export const acceptInviteSchema = z.object({
  token: z.string().regex(/^team_[A-Za-z0-9_-]{43}$/),
});

export type CreateStaffInput = z.output<typeof createStaffSchema>;
export type UpdateStaffInput = z.output<typeof updateStaffSchema>;
export type SendInviteInput = z.output<typeof sendInviteSchema>;
export type RevokeAccessInput = z.output<typeof revokeAccessSchema>;
