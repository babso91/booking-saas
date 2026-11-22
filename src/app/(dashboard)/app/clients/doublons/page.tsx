import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { AppShell } from "@/features/agenda/components/app-shell";
import { DuplicateReview } from "@/features/crm/components/duplicate-review";

export const metadata: Metadata = {
  title: "Doublons possibles",
};

/** Records that look alike, for her to check (point 147). */
export default async function ClientDuplicatesPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="clients"
    >
      <DuplicateReview
        key={`${user.id}:${business.id}`}
        timeZone={business.timezone}
      />
    </AppShell>
  );
}
