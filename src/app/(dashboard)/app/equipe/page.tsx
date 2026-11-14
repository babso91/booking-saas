import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AppShell } from "@/features/agenda/components/app-shell";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { TeamScreen } from "@/features/team/team-screen";

export const metadata: Metadata = {
  title: "Équipe",
};

export default async function TeamPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="team"
    >
      <TeamScreen />
    </AppShell>
  );
}
