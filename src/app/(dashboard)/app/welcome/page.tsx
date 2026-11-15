import type { Metadata } from "next";

import { BrandMark } from "@/components/shared/brand-mark";
import { requireReadyBusiness } from "@/features/auth/data/guards";
import { getSetupProgress } from "@/features/businesses/data/setup-progress";
import { OnboardingSuccess } from "@/features/onboarding/components/onboarding-success";
import { getSite } from "@/features/sites/data/sites";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Ton espace est prêt",
};

// End of onboarding. Behind the /app guard (ready state only); the name and
// the setup progress come from the server, never from client state.
export default async function WelcomePage() {
  const { business } = await requireReadyBusiness();
  const client = await createServerSupabaseClient();
  const [progress, site] = await Promise.all([
    getSetupProgress(client, business.id),
    getSite(client, business.id),
  ]);

  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-hidden px-5 pt-[max(env(safe-area-inset-top),0.75rem)] sm:px-10">
      <header className="relative flex h-14 items-center">
        <BrandMark />
      </header>
      <main className="relative flex flex-1 flex-col justify-center py-10 pb-[max(env(safe-area-inset-bottom),2.5rem)]">
        <OnboardingSuccess
          businessName={business.name}
          progress={progress}
          sitePublished={Boolean(site?.published)}
        />
      </main>
    </div>
  );
}
