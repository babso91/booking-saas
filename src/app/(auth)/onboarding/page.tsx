import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Configurer mon activité",
};

// Placeholder owned by the UI branch: the form calls completeOnboardingAction
// and checkSlugAction (src/features/onboarding/actions/onboarding.ts).
export default function OnboardingFoundationPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold text-stone-950">
        Configurer mon activité
      </h1>
    </main>
  );
}
