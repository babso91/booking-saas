import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { AppShell } from "@/features/agenda/components/app-shell";
import { PlanOverview } from "@/features/platform/plan-overview";
import { getSite } from "@/features/sites/data/sites";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Mon offre",
};

// Her plan as the server keeps it (sites.plan; a business without a site
// is on Core) and what it allows. No offers are listed yet: prices and
// changing plan wait for the platform's own contract
// (docs/PLATFORM_OFFERS_PROPOSAL.md).
export default async function PlanPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();
  const site = await getSite(await createServerSupabaseClient(), business.id);

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="site"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
          <PlanOverview current={site?.plan ?? "core"} offers={null} />
        </div>
      </div>
    </AppShell>
  );
}
