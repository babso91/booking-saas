import type { Metadata } from "next";

import { AppShell } from "@/features/agenda/components/app-shell";
import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { CampaignsScreen } from "@/features/growth/campaigns-screen";

export const metadata: Metadata = {
  title: "Relances",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CampaignsPage({
  searchParams,
}: PageProps<"/app/loyalty/relances">) {
  const { user, business } = await requireReadyBusiness();
  const { campagne } = await searchParams;
  const campaignId =
    typeof campagne === "string" && UUID.test(campagne) ? campagne : null;

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="loyalty"
    >
      <CampaignsScreen
        key={`${user.id}:${business.id}:${campaignId ?? "new"}`}
        campaignId={campaignId}
      />
    </AppShell>
  );
}
