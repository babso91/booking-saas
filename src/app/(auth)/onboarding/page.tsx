import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-shell";
import { requirePendingOnboarding } from "@/features/auth/data/guards";
import { BetaNotice } from "@/features/beta/components/beta-notice";
import { hasBetaAccess } from "@/features/beta/invitations";
import { OnboardingFlow } from "@/features/onboarding/components/onboarding-flow";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Configurer mon activité",
};

// The layout guard alone does not stop this page from rendering (segments
// render in parallel and would still reach the RSC payload of the redirect),
// so the page checks too. Same cached session state, no extra request.
export default async function OnboardingPage() {
  const state = await requirePendingOnboarding();

  // Private beta: without access, her business would be refused at the
  // end. She is told now, not after four steps.
  if (!(await hasBetaAccess(await createServerSupabaseClient()))) {
    return (
      <AuthShell>
        <BetaNotice reason="onboarding" />
      </AuthShell>
    );
  }

  return <OnboardingFlow owner={state.user.id} />;
}
