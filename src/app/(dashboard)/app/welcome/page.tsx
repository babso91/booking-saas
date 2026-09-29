import type { Metadata } from "next";

import { BrandMark } from "@/components/shared/brand-mark";
import { requireReadyBusiness } from "@/features/auth/data/guards";
import { OnboardingSuccess } from "@/features/onboarding/components/onboarding-success";

export const metadata: Metadata = {
  title: "Ton espace est prêt",
};

// End of onboarding. Behind the /app guard (ready state only); the slug and
// name come from the server session, never from client state.
export default async function WelcomePage() {
  const { business } = await requireReadyBusiness();

  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-hidden px-5 pt-[max(env(safe-area-inset-top),0.75rem)] sm:px-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-60 left-1/2 size-[720px] -translate-x-1/2 animate-fade rounded-full bg-[radial-gradient(circle_at_center,rgba(151,73,58,0.14),transparent_62%)]"
      />
      <header className="relative flex h-14 items-center">
        <BrandMark />
      </header>
      <main className="relative flex flex-1 flex-col justify-center py-10 pb-[max(env(safe-area-inset-bottom),2.5rem)]">
        <OnboardingSuccess slug={business.slug} businessName={business.name} />
      </main>
    </div>
  );
}
