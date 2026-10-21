import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AppShell } from "@/features/agenda/components/app-shell";
import { LoyaltySettings } from "@/features/loyalty/components/loyalty-settings";

export const metadata: Metadata = {
  title: "Fidélité",
};

export default async function LoyaltyPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="loyalty"
    >
      {/* One screen per identity: nothing read or typed for one reaches another. */}
      <LoyaltySettings key={`${user.id}:${business.id}`} />
    </AppShell>
  );
}
