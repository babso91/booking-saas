import type { Metadata } from "next";

import { currentSessionState } from "@/features/auth/data/guards";
import { OnboardingFlow } from "@/features/onboarding/components/onboarding-flow";

export const metadata: Metadata = {
  title: "Configurer mon activité",
};

// Access control stays in ./layout.tsx (requirePendingOnboarding): this page
// only renders for a signed-in user without a business.
export default async function OnboardingPage() {
  const state = await currentSessionState();
  const owner =
    state.status === "onboarding_required" ? state.user.email : null;

  return <OnboardingFlow owner={owner} />;
}
