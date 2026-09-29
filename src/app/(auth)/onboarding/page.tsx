import type { Metadata } from "next";

import { requirePendingOnboarding } from "@/features/auth/data/guards";
import { OnboardingFlow } from "@/features/onboarding/components/onboarding-flow";

export const metadata: Metadata = {
  title: "Configurer mon activité",
};

// The layout guard alone does not stop this page from rendering (segments
// render in parallel and would still reach the RSC payload of the redirect),
// so the page checks too. Same cached session state, no extra request.
export default async function OnboardingPage() {
  const state = await requirePendingOnboarding();

  return <OnboardingFlow owner={state.user.id} />;
}
