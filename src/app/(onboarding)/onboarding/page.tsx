import type { Metadata } from "next";

import { MockScenarioPanel } from "@/features/auth/components/mock-scenario-panel";
import { OnboardingFlow } from "@/features/onboarding/components/onboarding-flow";

export const metadata: Metadata = {
  title: "Configurer mon espace",
};

export default function OnboardingPage() {
  return (
    <>
      <OnboardingFlow />
      <MockScenarioPanel />
    </>
  );
}
