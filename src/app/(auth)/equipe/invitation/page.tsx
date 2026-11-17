import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-shell";
import { getSessionState } from "@/features/auth/data/session";
import { TeamJoin } from "@/features/team/team-join";
import { TEAM_INVITE_TOKEN_PATTERN } from "@/features/team/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Where a team invitation's links land (docs/TEAM_CONTRACT.md): the
// invitation email (?token=team_…), and the confirmation or recovery link
// of the sign-up it started (no token: kept server-side for two hours).
// The server actions decide everything; this page only routes her.
export const metadata: Metadata = {
  title: "Rejoindre l’équipe",
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function TeamInvitationPage({
  searchParams,
}: PageProps<"/equipe/invitation">) {
  const { token } = await searchParams;
  const session = await getSessionState(await createServerSupabaseClient());
  const valid =
    typeof token === "string" && TEAM_INVITE_TOKEN_PATTERN.test(token)
      ? token
      : null;
  return (
    <AuthShell>
      <TeamJoin token={valid} signedIn={session.status !== "unauthenticated"} />
    </AuthShell>
  );
}
