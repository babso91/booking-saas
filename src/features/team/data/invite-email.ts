import "server-only";

import type { ConfiguredTransport } from "@/features/notifications/transport";
import { escapeHtml } from "@/features/notifications/templates/render";
import { TEAM_INVITATION_PAGE } from "@/features/team/data/join";
import { hashTeamInviteToken } from "@/features/team/data/team";
import { getPublicEnv } from "@/lib/env/public";
import { AppException } from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// The team invitation email. Sent directly through the configured transport,
// like the Client Hub's login code: the outbox freezes every rendered
// message in the database, where a live link must not be kept. A failed
// send is not retried: she is invited again (the previous link stops
// working). The idempotency key is the token's hash: one link, one email.

const SEND_TIMEOUT_MS = 10_000;

export type TeamInviteEmail = {
  to: string;
  link: string;
  businessName: string;
  inviterName: string | null;
  role: string;
  expiresAt: string;
  tokenHash: string;
};

export function renderTeamInviteEmail(input: TeamInviteEmail) {
  const who = input.inviterName
    ? `${input.inviterName} vous invite`
    : "Vous êtes invitée";
  const role = input.role === "admin" ? "administratrice" : "praticienne";
  const until = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeZone: "Europe/Paris",
  }).format(new Date(input.expiresAt));
  const subject = `Rejoignez l’équipe de ${input.businessName}`;
  const text = [
    "Bonjour,",
    "",
    `${who} à rejoindre l’équipe de ${input.businessName} en tant que ${role}.`,
    "",
    `Pour accepter, ouvrez ce lien (valable jusqu’au ${until}) :`,
    input.link,
    "",
    "Utilisez cette adresse e-mail pour créer votre compte ou vous connecter.",
    "Si vous ne vous attendiez pas à cette invitation, ignorez cet e-mail.",
  ].join("\n");
  const html = `<p>Bonjour,</p><p>${escapeHtml(who)} à rejoindre l’équipe de <strong>${escapeHtml(input.businessName)}</strong> en tant que ${role}.</p><p><a href="${escapeHtml(input.link)}">Accepter l’invitation</a> (valable jusqu’au ${escapeHtml(until)}).</p><p>Utilisez cette adresse e-mail pour créer votre compte ou vous connecter. Si vous ne vous attendiez pas à cette invitation, ignorez cet e-mail.</p>`;
  return { subject, text, html };
}

export async function sendTeamInviteEmail(
  configured: ConfiguredTransport,
  input: TeamInviteEmail,
) {
  const { subject, text, html } = renderTeamInviteEmail(input);
  await configured.transport.send(
    {
      to: input.to,
      from: configured.from,
      subject,
      text,
      html,
      idempotencyKey: `team-invite-${input.tokenHash.slice(0, 32)}`,
    },
    AbortSignal.timeout(SEND_TIMEOUT_MS),
  );
}

/**
 * Sends the email of the invitation `token` just recorded. For a replayed
 * send_team_invitation, the invitation it recorded takes this token if it
 * is still pending (its first email may have failed), and the email leaves
 * again; nothing if it is no longer pending. Throws
 * `invitation_email_unavailable` if the transport refuses it.
 */
export async function deliverTeamInvite(
  configured: ConfiguredTransport,
  token: string,
  operation: { businessId: string; operationId: string },
): Promise<void> {
  const tokenHash = hashTeamInviteToken(token);
  const service = createAdminSupabaseClient() as AppSupabaseClient;
  const emailOf = () =>
    service
      .rpc("team_invitation_email", { p_token_hash: tokenHash })
      .maybeSingle();
  let { data, error } = await emailOf();
  if (error) throw databaseException(error);
  if (!data) {
    // A replay (the caller is the operation's author, checked by
    // send_team_invitation): its invitation, if still pending, takes this
    // token, and its email leaves again.
    const rotated = await service.rpc("rotate_team_invitation_token", {
      p_business_id: operation.businessId,
      p_operation_id: operation.operationId,
      p_token_hash: tokenHash,
    });
    if (rotated.error) throw databaseException(rotated.error);
    if (!rotated.data) return;
    ({ data, error } = await emailOf());
    if (error) throw databaseException(error);
    if (!data) return;
  }
  const link = new URL(
    TEAM_INVITATION_PAGE,
    new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).origin,
  );
  link.searchParams.set("token", token);
  try {
    await sendTeamInviteEmail(configured, {
      to: data.email,
      link: link.toString(),
      businessName: data.business_name,
      inviterName: data.inviter_name,
      role: data.role,
      expiresAt: data.expires_at,
      tokenHash,
    });
  } catch {
    // Never logs the address or the link.
    console.error("Team invitation email could not be sent.");
    throw new AppException("invitation_email_unavailable");
  }
}
