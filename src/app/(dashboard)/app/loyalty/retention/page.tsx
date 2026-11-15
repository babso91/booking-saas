import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { AppShell } from "@/features/agenda/components/app-shell";
import { RetentionScreen } from "@/features/retention/retention-screen";

export const metadata: Metadata = {
  title: "Fidélisation",
};

export default async function RetentionPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="loyalty"
    >
      {/* One screen per identity: nothing read for one reaches another. */}
      <RetentionScreen key={`${user.id}:${business.id}`} />
    </AppShell>
  );
}
