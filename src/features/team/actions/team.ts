"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  currentSessionId,
  endOtherSessions,
  isFreshRecovery,
} from "@/features/auth/data/session-proof";
import { authException } from "@/features/auth/data/auth-errors";
import { getEmailTransport } from "@/features/notifications/transport";
import { deliverTeamInvite } from "@/features/team/data/invite-email";
import {
  acceptTeamInvitationFor,
  joinTeam,
  teamInvitedAccount,
} from "@/features/team/data/join";
import {
  createStaff,
  getTeam,
  revokeAccess,
  sendInvite,
  updateStaff,
} from "@/features/team/data/team";
import {
  forgetTeamInvitation,
  rememberedTeamInvitation,
} from "@/features/team/invitation-cookie";
import {
  acceptInviteSchema,
  completeTeamInviteSchema,
  createStaffSchema,
  revokeAccessSchema,
  sendInviteSchema,
  updateStaffSchema,
} from "@/features/team/schemas";
import {
  AppException,
  toAppError,
  validationException,
  type ActionResult,
} from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";

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
 * Records the invitation and sends its email (docs/TEAM_CONTRACT.md,
 * « Invitation »). The token never reaches the screen. Without an email
 * transport nothing is recorded (`invitation_email_unavailable`); if the
 * email is refused after recording, the same code: retrying with the same
 * operationId sends it again with a new link.
 */
export async function sendInviteAction(input: unknown) {
  const result = await runBusinessAction(
    sendInviteSchema,
    input,
    async ({ client, businessId }, data) => {
      const transport = getEmailTransport();
      if (!transport) {
        console.error(
          "Team invitation refused: email delivery is not configured.",
        );
        throw new AppException("invitation_email_unavailable");
      }
      const { member, token } = await sendInvite(client, businessId, data);
      await deliverTeamInvite(transport, token, {
        businessId,
        operationId: data.operationId,
      });
      return member;
    },
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

async function invitationToken(token: string | undefined): Promise<string> {
  const value = token ?? (await rememberedTeamInvitation());
  if (!value) throw new AppException("beta_invitation_required");
  return value;
}

async function runJoin<T>(
  operation: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Team invitation acceptance failed", error);
    }
    return { ok: false, error: toAppError(error) };
  }
}

/**
 * /equipe/invitation: the signed-in person (invited address, confirmed)
 * joins the business. `token` from her link, or the one kept on this device
 * by her sign-up. Her other sessions end first. A session that did not
 * prove her password (a recovery link) answers
 * `invitation_password_required`: she chooses it (completeTeamInviteAction).
 */
export async function acceptTeamInviteAction(
  input: unknown,
): Promise<ActionResult<{ businessId: string; next: "/app" }>> {
  return runJoin(async () => {
    const parsed = acceptInviteSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new AppException("invitation_invalid", { cause: parsed.error });
    }
    const token = await invitationToken(parsed.data.token);
    const client = await createServerSupabaseClient();
    const businessId = await joinTeam(client, token);
    await forgetTeamInvitation();
    revalidateTeamPages();
    return { businessId, next: "/app" as const };
  });
}

/**
 * /equipe/invitation after her recovery link (an account made before her
 * invitation, maybe by someone else): sets HER password, ends every other
 * session, then joins. Requires the session opened by that link, within
 * the hour (`invitation_invalid` otherwise: she starts again from her
 * link). Retrying is safe.
 */
export async function completeTeamInviteAction(
  input: unknown,
): Promise<ActionResult<{ businessId: string; next: "/app" }>> {
  return runJoin(async () => {
    const parsed = completeTeamInviteSchema.safeParse(input);
    if (!parsed.success) throw validationException(parsed.error);
    const token = await invitationToken(parsed.data.token);

    const client = await createServerSupabaseClient();
    const { data } = await client.auth.getUser();
    const user = data.user;
    if (!user?.email) throw new AppException("unauthenticated");
    const { sessionId, amr } = await currentSessionId(client, user.id);
    if (!user.email_confirmed_at || !isFreshRecovery(amr)) {
      throw new AppException("invitation_invalid");
    }
    const service = createAdminSupabaseClient() as AppSupabaseClient;
    const account = await teamInvitedAccount(service, token, user.email);
    if (account.state !== "confirmed" || account.userId !== user.id) {
      throw new AppException("invitation_invalid");
    }

    // Her password replaces whatever it was (a third party's, maybe).
    const updated = await client.auth.updateUser({
      password: parsed.data.password,
    });
    if (updated.error && updated.error.code !== "same_password") {
      throw authException(updated.error);
    }
    await endOtherSessions(client);
    const businessId = await acceptTeamInvitationFor(
      service,
      token,
      user.email,
      user.id,
      sessionId,
    );
    await forgetTeamInvitation();
    revalidateTeamPages();
    return { businessId, next: "/app" as const };
  });
}
