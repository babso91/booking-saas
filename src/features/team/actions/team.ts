"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  acceptInvite,
  createStaff,
  getTeam,
  revokeAccess,
  sendInvite,
  updateStaff,
} from "@/features/team/data/team";
import {
  acceptInviteSchema,
  createStaffSchema,
  revokeAccessSchema,
  sendInviteSchema,
  updateStaffSchema,
} from "@/features/team/schemas";
import { AppException, toAppError, type ActionResult } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Her team (docs/TEAM_CONTRACT.md): the TeamActions object of the screen.
// The business is always the session's; the database checks the role, the
// business, the revision, and replays by operationId.

function revalidateTeamPages() {
  revalidatePath("/app", "layout");
}

export async function readTeamAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    getTeam(client, businessId),
  );
}

export async function createStaffAction(input: unknown) {
  const result = await runBusinessAction(
    createStaffSchema,
    input,
    ({ client, businessId }, data) => createStaff(client, businessId, data),
  );
  if (result.ok) revalidateTeamPages();
  return result;
}

export async function updateStaffAction(input: unknown) {
  const result = await runBusinessAction(
    updateStaffSchema,
    input,
    ({ client, businessId }, data) => updateStaff(client, businessId, data),
  );
  if (result.ok) revalidateTeamPages();
  return result;
}

/**
 * The invitation is recorded; its email leaves with the email transport
 * once one is validated (docs/TEAM_CONTRACT.md, « Invitation »). The token
 * never reaches the screen.
 */
export async function sendInviteAction(input: unknown) {
  const result = await runBusinessAction(
    sendInviteSchema,
    input,
    async ({ client, businessId }, data) =>
      (await sendInvite(client, businessId, data)).member,
  );
  if (result.ok) revalidateTeamPages();
  return result;
}

export async function revokeAccessAction(input: unknown) {
  const result = await runBusinessAction(
    revokeAccessSchema,
    input,
    ({ client, businessId }, data) => revokeAccess(client, businessId, data),
  );
  if (result.ok) revalidateTeamPages();
  return result;
}

/** The signed-in person (invited address, confirmed) joins the business. */
export async function acceptTeamInviteAction(
  input: unknown,
): Promise<ActionResult<{ businessId: string }>> {
  try {
    const parsed = acceptInviteSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppException("invitation_invalid", { cause: parsed.error });
    }
    const client = await createServerSupabaseClient();
    const businessId = await acceptInvite(client, parsed.data.token);
    revalidateTeamPages();
    return { ok: true, data: { businessId } };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Team invitation acceptance failed", error);
    }
    return { ok: false, error: toAppError(error) };
  }
}
